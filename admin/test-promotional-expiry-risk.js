#!/usr/bin/env node
/*
  admin/test-promotional-expiry-risk.js
  ======================================
  Prueba de la corrección del incidente 2026-09-13 (prueba manual real
  del panel: un borrador promocional y con el plazo ya vencido -- el
  "final, final, final call" de TechCrunch Disrupt 2026, plazo 11 de
  septiembre, corrida el 13 -- se ofrecía como "Usar este borrador" con
  Riesgo editorial y Estado de aprobación en verde).

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox
  real ni la carpeta del usuario), levantando el propio admin/server.js
  real como subproceso -- las pruebas HTTP pegan contra los mismos
  endpoints que usa el panel de verdad, no una reimplementación.

  Pruebas (letras según el pedido del usuario):
    A. URL/borrador promocional real (TechCrunch Disrupt): GET /api/drafts
       lo marca recommendation:"descartar", eligibleToUse:false.
    B. La MISMA heurística, con una fecha límite en el futuro vs. una en
       el pasado, cambia de "no vencido" a "vencido" -- demuestra que la
       clasificación es relativa a HOY, no un valor fijo guardado (el
       mecanismo real detrás de "la misma nota, después de vencida,
       queda bloqueada").
    C. Borrador limpio sin la casilla de aprobación, intentando publicar:
       POST /api/validate-article -> issue en editorialApproval; PUT
       real -> 422.
    D. El mismo borrador promocional, con editorialApproval:true a la
       fuerza: sigue bloqueado (422) -- la aprobación humana NO puede
       pasar por encima del filtro estructural.
    E. Noticia legítima y reciente, con aprobación real: se guarda bien
       (200).
    F. Entertainment/Sports no aparecen entre las categorías que ofrece
       buildCandidates() para noticias nuevas.
    G. El panel indica explícitamente "Modo RSS sin métricas" (no finge
       Google Trends) -- verificado en el HTML servido.
    H. Los archivos estáticos del panel se sirven con Cache-Control:
       no-store (no debería hacer falta un hard-refresh nunca más).
    I. Los 141 artículos reales (sitio real, no la copia) no cambiaron.
    J. El borrador de prueba se elimina por completo (toda la copia
       aislada, incluido su drafts.json, vive en un tmpdir que se borra
       al final).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

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

// ---- I. Snapshot del sitio REAL antes de tocar nada (solo lectura) ----
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-risk-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');
const pipeline = require(path.join(adminDir, 'pipeline.js'));

// ---- Fixture real: el draft promocional tal como quedó en la carpeta
// real del usuario (texto exacto del cuerpo, no reconstruido a mano) ----
const REAL_PROMO_DRAFT = {
  title: 'Deadline Approaches for Hosting Side Events at TechCrunch Disrupt 2026',
  category: 'business', categoryLabel: 'Business', icon: '💰', date: '2026-09-13',
  slug: 'deadline-approaches-for-hosting-side-events-at-techcrunch-di',
  dek: 'TechCrunch Disrupt 2026 is inviting final submissions for official Side Events, marking an important opportunity for innovators and startups to showcase their ideas and connect with industry leaders.',
  image: 'img/temas/tsmc-expands-investment-us-chip-plants.jpg', imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
  body: 'The stage is set for TechCrunch Disrupt 2026, one of the premier technology conferences that brings together entrepreneurs, investors, and tech enthusiasts. As the event approaches, an important deadline looms for those looking to make their mark on the Disrupt experience.\n\nThe final call to apply for hosting an official Side Event is scheduled for tonight, September 11, at 11:59 p.m. PT. Side Events are an integral part of the Disrupt experience, providing an avenue for attendees to engage in discussions, networking, and workshops on topics that extend beyond the primary conference agenda.\n\n## What are Side Events?\n\nSide Events at TechCrunch Disrupt serve as unofficial gatherings that run concurrently with the main conference sessions. They can range from panel discussions and product demonstrations to pitch competitions or informal meetups.',
  sourceUrl: 'https://techcrunch.com/2026/09/11/final-final-final-call-for-techcrunch-disrupt-2026-side-events/',
  sourceTitle: 'Final, final, final call for TechCrunch Disrupt 2026 Side Events',
  similarityWarning: false, similarityScore: 49, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
const LEGIT_DRAFT = {
  // Título/slug elegidos a propósito para NO compartir palabras
  // significativas con "Prueba sintética legítima aprobada 13sep" (el
  // artículo sintético que este mismo archivo publica más abajo, parte G)
  // -- coincidían en "prueba/sintética/legítima" y el chequeo nuevo de
  // duplicados de classifyDraft() (2026-09-20, puntuación editorial) los
  // marcaba como el mismo hecho por simple parecido de redacción de
  // pruebas, no por ser de verdad la misma noticia. Ver informe de esa
  // fecha para el detalle completo.
  // Categoría del control (pedido de Leonardo, 2026-09-25: reorganización
  // de categorías) -- "science" pasó a ser la categoría excluida de
  // noticias nuevas (se integra editorialmente en Technology, ver
  // data/categories.json y EXCLUDED_NEW_DRAFT_CATEGORIES en
  // admin/pipeline.js), así que un control "legítimo" tiene que usar una
  // categoría de verdad ACTIVA para noticias nuevas.
  title: 'Control de borrador limpio: nuevo chip de bajo consumo llega a laptops del mercado masivo',
  category: 'technology', categoryLabel: 'Technology', icon: '💻', date: pipeline.todayISO(),
  slug: 'control-borrador-limpio-chip-bajo-consumo-laptops-13sep',
  dek: 'Borrador de control usado solo para probar que el filtro nuevo no bloquea contenido normal.',
  body: 'Contenido de prueba sobre un lanzamiento tecnológico de ejemplo, sin lenguaje promocional ni fechas límite, usado únicamente para validar el pipeline.',
  sourceUrl: 'https://www.theverge.com/example-synthetic-test',
  sourceTitle: 'Ejemplo sintético', similarityWarning: false, similarityScore: 0, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
fs.writeFileSync(path.join(dataDir, 'drafts.json'), JSON.stringify([REAL_PROMO_DRAFT, LEGIT_DRAFT], null, 2));

// ---- A + parte de G/H: clasificación directa (sin servidor) ----
{
  const r = pipeline.classifyDraft(REAL_PROMO_DRAFT);
  check('A. Draft promocional real -> promotional:true', r.promotional === true, JSON.stringify(r));
  check('A. Draft promocional real -> expired:true (plazo del 11/9 ya pasado)', r.expired === true, JSON.stringify(r));
  check('A. Draft promocional real -> recommendation:"descartar"', r.recommendation === 'descartar');
  check('A. Draft promocional real -> eligibleToUse:false ("Usar este borrador" no elegible)', r.eligibleToUse === false);
  const rLegit = pipeline.classifyDraft(LEGIT_DRAFT);
  check('A(control). Draft legítimo -> recommendation:"crear"', rLegit.recommendation === 'crear', JSON.stringify(rLegit));
}

// ---- B. La misma heurística cambia con la fecha (relativa a HOY) ----
{
  const future = pipeline.isDeadlinePassed('The deadline to register is December 31, 2099.', new Date('2026-09-13'));
  const past = pipeline.isDeadlinePassed('The deadline to register is December 31, 2020.', new Date('2026-09-13'));
  check('B. Plazo en el futuro -> expired:false', future.expired === false, JSON.stringify(future));
  check('B. Mismo tipo de frase con plazo en el pasado -> expired:true', past.expired === true, JSON.stringify(past));
}

// ---- F. Categorías activas para "noticias nuevas" (pedido de Leonardo,
// 2026-09-25: reorganización de categorías) -- Entertainment y Sports
// volvieron a estar ACTIVAS (dejaron de estarlo el 2026-09-13, ver el
// historial de este archivo); Science pasó a ser la excluida, integrada
// editorialmente en Technology. ----
{
  const excluded = pipeline.EXCLUDED_NEW_DRAFT_CATEGORIES;
  check('F. "entertainment" ya NO está excluido de noticias nuevas (reactivado 2026-09-25)', !excluded.has('entertainment'));
  check('F. "sports" ya NO está excluido de noticias nuevas (reactivado 2026-09-25)', !excluded.has('sports'));
  check('F. "science" está excluido de noticias nuevas (se integra en Technology)', excluded.has('science'));
  // Categorías reales (editor manual / resto del panel) siguen intactas:
  // ninguna de las tres debe haber sido removida de listCategories() --
  // "excluida de noticias nuevas" nunca significa "borrada del sitio".
  const cats = pipeline.listCategories().map(function (c) { return c.slug; });
  check('F. Entertainment SIGUE existiendo como categoría real del sitio', cats.indexOf('entertainment') !== -1);
  check('F. Sports SIGUE existiendo como categoría real del sitio', cats.indexOf('sports') !== -1);
  check('F. Science SIGUE existiendo como categoría real del sitio (no se borró, solo se excluye de la búsqueda y del menú)', cats.indexOf('science') !== -1);
}

// ---- G. El panel dice explícitamente de dónde sale el descubrimiento ----
{
  const html = fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8');
  check('G. admin/index.html declara el modo real (Google Trends con respaldo RSS), sin fingir ni ocultar nada', html.indexOf('Modo Google Trends (Estados Unidos)') !== -1);
}

// ---- Levantar el servidor real (subproceso) para C/D/E/H ----
const PORT = 4322; // puerto de prueba, no el 4321 real
// admin/server.js tiene el puerto hardcodeado en 4321 -- se parchea SOLO
// en la copia aislada para no chocar con una instancia real que el
// usuario pueda tener abierta en su propia máquina.
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

function baseArticleTemplate() {
  const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
  const tmpl = all.find(function (a) { return a.slug === 'nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop'; });
  const clone = JSON.parse(JSON.stringify(tmpl));
  clone.noindex = false;
  clone.noindexReason = '';
  delete clone.correctionNote;
  return clone;
}

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  // ---- C. Borrador limpio, sin aprobación, intentando publicar ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-sin-aprobacion-13sep';
    article.title = 'Prueba sintética sin aprobación 13sep';
    article.dek = 'Dek sintético de prueba distinto del título.';
    article.date = pipeline.todayISO();
    article.status = 'published';
    article.editorialApproval = false;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const vres = await fetch('http://127.0.0.1:' + PORT + '/api/validate-article', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles: [article], slug: article.slug })
    }).then(function (r) { return r.json(); });
    const hasApprovalIssue = (vres.issues || []).some(function (i) { return i.field === 'editorialApproval'; });
    check('C. /api/validate-article marca editorialApproval como issue cuando falta la casilla y se intenta publicar', hasApprovalIssue, JSON.stringify(vres));

    const pres = await fetch('http://127.0.0.1:' + PORT + '/api/articles/' + article.category + '/' + article.slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(article)
    });
    check('C. PUT real sin aprobación, status published -> 422', pres.status === 422, 'status=' + pres.status);
  }

  // ---- D. Promocional + aprobación forzada en true -> sigue bloqueado ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-promocional-forzada-13sep';
    article.title = 'Deadline Approaches for Hosting Side Events at TechCrunch Disrupt 2026 (prueba)';
    article.dek = 'TechCrunch Disrupt 2026 is inviting final submissions for official Side Events -- prueba sintética.';
    article.date = pipeline.todayISO();
    article.body = REAL_PROMO_DRAFT.body + '\n\n## Contenido adicional\n\nTexto de relleno para superar el mínimo de palabras exigido por validateArticleContent en esta prueba sintética, sin agregar ningún dato nuevo real, solo para poder aislar el efecto del filtro promocional del resto de los controles de contenido.';
    article.sourceUrl = REAL_PROMO_DRAFT.sourceUrl;
    article.sourceTitle = REAL_PROMO_DRAFT.sourceTitle;
    article.status = 'published';
    article.editorialApproval = true; // a propósito: la casilla SÍ está tildada
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const pres = await fetch('http://127.0.0.1:' + PORT + '/api/articles/' + article.category + '/' + article.slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(article)
    });
    const body = await pres.json().catch(function () { return {}; });
    const blockedIssues = ((body.blocked || [])[0] || {}).issues || [];
    const hasPromoIssue = blockedIssues.some(function (i) { return /promocional/i.test(i.message); });
    check('D. Promocional + editorialApproval:true -> SIGUE bloqueado (422)', pres.status === 422, 'status=' + pres.status);
    check('D. El motivo de bloqueo menciona el contenido promocional', hasPromoIssue, JSON.stringify(body));
  }

  // ---- E. Noticia legítima y reciente, con aprobación real -> se guarda ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-legitima-aprobada-13sep';
    article.title = 'Prueba sintética legítima aprobada 13sep';
    article.dek = 'Dek sintético legítimo, sin lenguaje promocional ni plazos vencidos, para confirmar que el filtro nuevo no bloquea contenido normal.';
    article.date = pipeline.todayISO();
    article.status = 'published';
    article.editorialApproval = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const pres = await fetch('http://127.0.0.1:' + PORT + '/api/articles/' + article.category + '/' + article.slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(article)
    });
    const body = await pres.json().catch(function () { return {}; });
    check('E. Noticia legítima + aprobación real -> se guarda (200)', pres.status === 200, 'status=' + pres.status + ' body=' + JSON.stringify(body));
  }

  // ---- H. Cache-Control: no-store en los estáticos del panel ----
  {
    const r = await fetch('http://127.0.0.1:' + PORT + '/admin.js');
    check('H. admin.js se sirve con Cache-Control: no-store', (r.headers.get('cache-control') || '').indexOf('no-store') !== -1, r.headers.get('cache-control'));
    const r2 = await fetch('http://127.0.0.1:' + PORT + '/');
    check('H. index.html del panel se sirve con Cache-Control: no-store', (r2.headers.get('cache-control') || '').indexOf('no-store') !== -1, r2.headers.get('cache-control'));
  }

  // ---- GET /api/drafts anota risk correctamente (extremo a extremo) ----
  {
    const list = await fetch('http://127.0.0.1:' + PORT + '/api/drafts').then(function (r) { return r.json(); });
    const promoEntry = list.find(function (d) { return d.slug === REAL_PROMO_DRAFT.slug; });
    check('A(HTTP). GET /api/drafts real anota risk.recommendation:"descartar" en el draft promocional', promoEntry && promoEntry.risk && promoEntry.risk.recommendation === 'descartar', JSON.stringify(promoEntry && promoEntry.risk));
    const legitEntry = list.find(function (d) { return d.slug === LEGIT_DRAFT.slug; });
    check('A(HTTP,control). GET /api/drafts real anota risk.recommendation:"crear" en el draft legítimo', legitEntry && legitEntry.risk && legitEntry.risk.recommendation === 'crear', JSON.stringify(legitEntry && legitEntry.risk));
  }

  child.kill();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas HTTP:', e);
  console.error('Salida del servidor de prueba:\n' + serverOutput);
  fail++;
  child.kill();
}).finally(function () {
  // ---- I. Confirmar que el sitio REAL no cambió en ningún momento ----
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('I. data/articulos.json del sitio REAL (141) no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('I. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  // ---- J. Limpieza total de la copia aislada (incluye el draft de prueba) ----
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('J. Copia aislada (con el borrador de prueba) eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
