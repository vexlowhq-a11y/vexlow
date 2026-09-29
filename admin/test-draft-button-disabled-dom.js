#!/usr/bin/env node
/*
  admin/test-draft-button-disabled-dom.js
  =========================================
  Seguimiento del incidente 2026-09-13: la detección de contenido
  promocional/vencido ya funcionaba (pipeline.classifyDraft), pero el
  botón "Usar este borrador" seguía VIÉNDOSE habilitado en la tarjeta.
  Este archivo no confía en leer el código fuente ni en inspeccionar
  `useBtn.disabled` desde dentro de admin.js -- carga el panel real
  (admin/index.html + admin/admin.css + admin/admin.js, sin tocar nada)
  en un DOM real (jsdom) contra el propio admin/server.js real corriendo
  como subproceso, y audita el elemento <button> tal como quedó
  renderizado, exactamente como lo vería el navegador de Leonardo.

  Pruebas:
    1. El botón del borrador promocional/vencido (TechCrunch Disrupt real)
       tiene el atributo `disabled` de verdad en el DOM (no solo la
       propiedad de JS) y `aria-disabled="true"`.
    2. Su estilo COMPUTADO (getComputedStyle, con el CSS real aplicado)
       tiene cursor "not-allowed" y opacidad reducida (gris/apagado) --
       no alcanza con que el atributo esté, tiene que VERSE distinto.
    3. Su `title` es exactamente "No se puede usar: contenido promocional
       o vencido".
    4. No es alcanzable por teclado: `.focus()` no lo deja como
       `document.activeElement` (un <button disabled> nunca es focusable).
    5. Un clic real (dispatchEvent de MouseEvent "click") no dispara
       ninguna acción -- se verifica que useDraft() no corrió (el título
       del formulario de artículo NO cambia a "Revisar borrador").
    6. El botón "Descartar" del mismo borrador SIGUE habilitado (el
       bloqueo es específico de "Usar este borrador", no de la tarjeta
       entera).
    7. El borrador LEGÍTIMO (control) mantiene su "Usar este borrador"
       habilitado: sin atributo disabled, sin aria-disabled, cursor normal.
    8. El servidor también rechaza el intento por otra vía (POST
       /api/articles directo con editorialApproval:true a la fuerza) --
       reconfirmación de que el bloqueo real no depende del botón.
    9. Los 141 artículos reales no cambiaron durante la prueba.
    10. La copia aislada (con el borrador de prueba) se borra por completo.
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

const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-btn-dom-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

const REAL_PROMO_DRAFT = {
  title: 'Deadline Approaches for Hosting Side Events at TechCrunch Disrupt 2026',
  category: 'business', categoryLabel: 'Business', icon: '💰', date: '2026-09-13',
  slug: 'deadline-approaches-for-hosting-side-events-at-techcrunch-di',
  dek: 'TechCrunch Disrupt 2026 is inviting final submissions for official Side Events, marking an important opportunity for innovators and startups to showcase their ideas and connect with industry leaders.',
  image: 'img/temas/tsmc-expands-investment-us-chip-plants.jpg', imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
  body: 'The stage is set for TechCrunch Disrupt 2026, one of the premier technology conferences that brings together entrepreneurs, investors, and tech enthusiasts. As the event approaches, an important deadline looms for those looking to make their mark on the Disrupt experience.\n\nThe final call to apply for hosting an official Side Event is scheduled for tonight, September 11, at 11:59 p.m. PT. Side Events are an integral part of the Disrupt experience.',
  sourceUrl: 'https://techcrunch.com/2026/09/11/final-final-final-call-for-techcrunch-disrupt-2026-side-events/',
  sourceTitle: 'Final, final, final call for TechCrunch Disrupt 2026 Side Events',
  similarityWarning: false, similarityScore: 49, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
// Categoría del control (pedido de Leonardo, 2026-09-25: reorganización de
// categorías): "science" pasó a ser la categoría excluida de noticias
// nuevas (se integra editorialmente en Technology, ver data/categories.json
// y EXCLUDED_NEW_DRAFT_CATEGORIES en admin/pipeline.js) -- un control
// "legítimo" tiene que usar una categoría de verdad ACTIVA para noticias
// nuevas, o este test terminaría probando lo contrario de lo que dice
// (antes de este pedido era al revés: "science" estaba activa y
// "entertainment"/"sports" excluidas).
const LEGIT_DRAFT = {
  title: 'Prueba sintética: noticia legítima y reciente (boton DOM)',
  category: 'technology', categoryLabel: 'Technology', icon: '💻', date: '2026-09-13',
  slug: 'prueba-sintetica-legitima-boton-dom-13sep',
  dek: 'Borrador sintético limpio usado solo para confirmar que el botón queda habilitado en contenido normal.',
  body: 'Contenido sintético de prueba, sin lenguaje promocional ni fechas límite.',
  sourceUrl: 'https://www.theverge.com/example-synthetic-test',
  sourceTitle: 'Ejemplo sintético', similarityWarning: false, similarityScore: 0, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
fs.writeFileSync(path.join(dataDir, 'drafts.json'), JSON.stringify([REAL_PROMO_DRAFT, LEGIT_DRAFT], null, 2));

const PORT = 4324; // puerto de prueba propio, distinto del real (4321) y del de la otra suite (4322)
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

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  // ---- Cargar el panel REAL en un DOM real (jsdom), con JS y CSS reales ----
  const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    // jsdom (esta versión) no trae `fetch` global -- admin.js lo usa en
    // TODO su init (getJSON/postJSON), así que sin esto ni siquiera llega
    // a Promise.all antes de tirar ReferenceError. Se resuelve contra el
    // origin real de la página (mismo patrón que usaría un navegador con
    // una URL relativa) usando el fetch nativo de este mismo proceso Node.
    beforeParse: function (win) {
      win.fetch = function (url, opts) {
        var abs = new URL(url, win.location.href).toString();
        return fetch(abs, opts);
      };
    }
  });
  const { window } = dom;

  // Silenciar el ruido esperado de jsdom (CSS que no reconoce, el fetch
  // externo a vexlowhq.com de loadReactions() que puede fallar en este
  // entorno sandbox -- ya está atrapado en un .catch() en admin.js y no
  // afecta nada de lo que se prueba acá).
  window.addEventListener('error', function () {});

  function rowForTitle(titleText) {
    var items = Array.from(window.document.querySelectorAll('.admin-item'));
    return items.find(function (row) {
      var ttl = row.querySelector('.ttl');
      return ttl && ttl.textContent.indexOf(titleText) !== -1;
    });
  }

  // Corrección 2026-09-20 (test flaky detectado -- misma familia de bug que
  // ya se corrigió este día en test-sources-merge-fix.js y se evitó de
  // entrada en test-commercial-deal-filter.js): esta espera comparaba la
  // cantidad TOTAL de elementos `.admin-item` contra un umbral fijo (>=2) --
  // pero esa misma clase la usa TAMBIÉN la lista de artículos ya publicados
  // (141/142 elementos reales), así que el umbral se cumplía casi de
  // inmediato por esa lista sola, mucho antes de que GET /api/drafts
  // terminara de traer y renderizar los dos borradores de esta prueba. El
  // resultado era una carrera: "Setup" pasaba, pero rowForTitle() todavía no
  // encontraba las tarjetas de borrador -- una falla intermitente del test,
  // no del código de producción. Se corrige esperando la condición real que
  // esta prueba necesita (las DOS tarjetas de borrador, por título, ya
  // presentes en el DOM), con un timeout máximo explícito y un mensaje de
  // error descriptivo si no aparecen a tiempo -- sin usar una pausa fija.
  var ambosBorradoresListos = false;
  var MAX_INTENTOS_ESPERA_BORRADORES = 60; // 60 * 200ms = 12s de timeout máximo
  for (var i = 0; i < MAX_INTENTOS_ESPERA_BORRADORES; i++) {
    await sleep(200);
    if (rowForTitle('Deadline Approaches for Hosting Side Events') &&
        rowForTitle('Prueba sintética: noticia legítima y reciente (boton DOM)')) {
      ambosBorradoresListos = true;
      break;
    }
  }
  check('Setup: el panel real terminó de cargar e inicializar (renderDraftsList corrió) y ambos borradores de prueba ya están en el DOM',
    ambosBorradoresListos,
    'admin-item encontrados=' + window.document.querySelectorAll('.admin-item').length +
    ' tras ' + MAX_INTENTOS_ESPERA_BORRADORES + ' intentos (timeout ' + (MAX_INTENTOS_ESPERA_BORRADORES * 200 / 1000) + 's) -- ' +
    'GET /api/drafts no devolvió a tiempo las tarjetas de "Deadline Approaches for Hosting Side Events" y/o ' +
    '"Prueba sintética: noticia legítima y reciente (boton DOM)"');
  if (!ambosBorradoresListos) throw new Error('El panel no terminó de renderizar ambos borradores de prueba a tiempo (timeout ' + (MAX_INTENTOS_ESPERA_BORRADORES * 200 / 1000) + 's): ' + serverOutput.slice(-2000));

  var promoRow = rowForTitle('Deadline Approaches for Hosting Side Events');
  check('Setup: se encontró la tarjeta del borrador promocional real de TechCrunch', !!promoRow);
  var legitRow = rowForTitle('Prueba sintética: noticia legítima y reciente (boton DOM)');
  check('Setup: se encontró la tarjeta del borrador legítimo de control', !!legitRow);

  if (promoRow) {
    var buttons = Array.from(promoRow.querySelectorAll('button'));
    var useBtn = buttons.find(function (b) { return b.textContent.trim() === 'Usar este borrador'; });
    var discardBtn = buttons.find(function (b) { return b.textContent.trim() === 'Descartar'; });

    check('1. Draft promocional: "Usar este borrador" tiene el ATRIBUTO disabled real en el HTML', useBtn && useBtn.hasAttribute('disabled'), useBtn && useBtn.outerHTML);
    check('1. Draft promocional: la propiedad .disabled también es true', useBtn && useBtn.disabled === true);
    check('1. Draft promocional: aria-disabled="true" presente', useBtn && useBtn.getAttribute('aria-disabled') === 'true');

    var computed = window.getComputedStyle(useBtn);
    check('2. Estilo computado: cursor = "not-allowed"', computed.cursor === 'not-allowed', 'cursor=' + computed.cursor);
    check('2. Estilo computado: opacity reducida (gris/apagado, < 1)', parseFloat(computed.opacity) < 1, 'opacity=' + computed.opacity);

    check('3. Tooltip exacto: "No se puede usar: contenido promocional o vencido"', useBtn.title === 'No se puede usar: contenido promocional o vencido', 'title="' + (useBtn && useBtn.title) + '"');

    useBtn.focus();
    check('4. No es alcanzable por teclado (focus() no lo deja como activeElement)', window.document.activeElement !== useBtn,
      'isConnected=' + useBtn.isConnected + ' activeElement=' + (window.document.activeElement && window.document.activeElement.outerHTML));

    var titleBefore = window.document.getElementById('articleFormTitle') ? window.document.getElementById('articleFormTitle').textContent : null;
    useBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(100);
    var titleAfter = window.document.getElementById('articleFormTitle') ? window.document.getElementById('articleFormTitle').textContent : null;
    check('5. Un clic real no ejecuta useDraft() (el título del formulario no cambia a "Revisar borrador")', titleAfter !== 'Revisar borrador', 'antes="' + titleBefore + '" despues="' + titleAfter + '"');

    check('6. "Descartar" del MISMO borrador sigue habilitado (el bloqueo es solo de "Usar este borrador")', discardBtn && !discardBtn.hasAttribute('disabled') && discardBtn.disabled === false);
  }

  if (legitRow) {
    var legitButtons = Array.from(legitRow.querySelectorAll('button'));
    var legitUseBtn = legitButtons.find(function (b) { return b.textContent.trim() === 'Usar este borrador'; });
    check('7. Draft legítimo (control): "Usar este borrador" SIN atributo disabled', legitUseBtn && !legitUseBtn.hasAttribute('disabled'));
    check('7. Draft legítimo (control): SIN aria-disabled', legitUseBtn && legitUseBtn.getAttribute('aria-disabled') !== 'true');
    var legitComputed = legitUseBtn && window.getComputedStyle(legitUseBtn);
    check('7. Draft legítimo (control): cursor normal (pointer, no not-allowed)', legitComputed && legitComputed.cursor !== 'not-allowed', legitComputed && legitComputed.cursor);
  }

  // Antes de cerrar el DOM: dar tiempo a que terminen otros fetches de init
  // del panel que no son parte de esta prueba (ej. estado de redes
  // sociales/sprint) -- sin esto, una de esas promesas puede resolver
  // DESPUÉS de window.close() y tirar abajo el proceso al tocar un
  // `document` ya destruido (visto acá mismo: renderSprintDays crasheaba
  // con "Cannot read properties of undefined (reading 'createElement')").
  // Mismo ajuste ya aplicado en test-commercial-deal-filter.js (2026-09-20):
  // el GET /api/drafts de este panel ahora recalcula clasificación/puntaje
  // para cada borrador contra los artículos reales (ver pipeline.classifyDraft
  // con allArticles), así que el init completo puede tardar algo más que
  // antes de esa mejora.
  await sleep(1000);
  window.close();

  // ---- 8. Reconfirmación del rechazo real del servidor (independiente
  // del botón: nadie depende de que el navegador respete el disabled) ----
  {
    var all = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    var tmpl = JSON.parse(JSON.stringify(all.find(function (a) { return a.slug === 'nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop'; })));
    tmpl.noindex = false; tmpl.noindexReason = ''; delete tmpl.correctionNote;
    tmpl.slug = 'prueba-sintetica-rechazo-servidor-boton-13sep';
    tmpl.title = 'Deadline Approaches for Hosting Side Events at TechCrunch Disrupt 2026 (prueba botón)';
    tmpl.dek = 'TechCrunch Disrupt 2026 is inviting final submissions for official Side Events -- prueba sintética del botón.';
    tmpl.date = '2026-09-13';
    tmpl.body = REAL_PROMO_DRAFT.body + '\n\n## Relleno\n\nTexto adicional solo para superar el mínimo de palabras exigido, sin agregar ningún dato real, para poder aislar el efecto del filtro promocional.';
    tmpl.sourceUrl = REAL_PROMO_DRAFT.sourceUrl;
    tmpl.sourceTitle = REAL_PROMO_DRAFT.sourceTitle;
    tmpl.status = 'published';
    tmpl.editorialApproval = true; // a propósito, forzado en true
    tmpl.href = 'categoria/' + tmpl.category + '/' + tmpl.slug + '.html';

    var pres = await fetch('http://127.0.0.1:' + PORT + '/api/articles/' + tmpl.category + '/' + tmpl.slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tmpl)
    });
    check('8. El servidor SIGUE rechazando (422) el mismo contenido promocional aunque no pase por el botón', pres.status === 422, 'status=' + pres.status);
  }

  child.kill();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas DOM:', e);
  console.error('Salida del servidor de prueba:\n' + serverOutput.slice(-3000));
  fail++;
  try { child.kill(); } catch (e2) {}
}).finally(function () {
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('9. data/articulos.json del sitio REAL (141) no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('9. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('10. Copia aislada (con los borradores de prueba) eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
