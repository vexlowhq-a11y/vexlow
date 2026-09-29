#!/usr/bin/env node
/*
  admin/test-check-url-security.js
  =================================
  Revisión de seguridad pedida por Leonardo (2026-09-20) sobre
  checkUrlReachable()/validateSourceUrlForFetch()/safeLookup() en
  admin/pipeline.js, y sobre /api/check-source en admin/server.js, ANTES
  de autorizar la sincronización de la "mejora global" de procedencia de
  fuentes RSS.

  Este archivo prueba, en orden, cada uno de los 12 puntos que pidió:
    1. Solo se aceptan URLs http:// y https://
    2. Se rechazan URLs con usuario/contraseña incorporados
    3. Se bloquean localhost, 127.0.0.0/8, 0.0.0.0, IP privadas, link-local,
       multicast, IPv6 local/privada y endpoints de metadatos de nube
    4. Se resuelve DNS y se comprueba la IP resultante ANTES de conectar
       (safeLookup, vía la opción `lookup` de http.request/https.request --
       la MISMA ip que se valida es la que se usa para conectar, así que no
       hay ventana para DNS rebinding)
    5. Esa validación se repite después de CADA redirección (una URL
       pública no puede redirigir a una dirección privada sin que se
       detecte)
    6. Redirecciones/timeout/datos descargados están limitados
    7. Nunca se descarga un archivo completo: HEAD primero, GET limitado
       si HEAD no está permitido
    8. Nunca se registran cuerpos de respuesta, cookies, credenciales ni
       secretos
    9. 404/410 = fuente inexistente; 401/403/429/5xx/timeout = no se pudo
       comprobar (nunca se afirma que la fuente no existe); respuesta
       válida = alcanzable
    10. La canonicalización de feeds.js solo saca parámetros de rastreo
        conocidos, nunca parámetros funcionales de la nota
    11. Batería explícita: URLs privadas, IPv4, IPv6, redirección
        pública->privada, exceso de redirecciones, timeout, respuesta
        demasiado grande, 403 y 429
    12. Las "afirmaciones principales" (keyClaims) quedan etiquetadas en
        el panel como extraídas automáticamente para revisión, nunca como
        hechos ya verificados

  Todo corre sobre una copia AISLADA del sitio (nunca el sandbox real) y
  contra servidores HTTP locales de prueba -- en ningún momento se toca
  la red pública real, ni siquiera para simular una dirección "pública":
  ver la nota grande más abajo sobre el mecanismo de simulación usado
  para el punto 5/11 (redirección pública->privada).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-check-url-security-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');
const adminDir = path.join(tmpRoot, 'admin');

async function main() {
  const pipeline = require(path.join(adminDir, 'pipeline.js'));
  const feeds = require(path.join(adminDir, 'feeds.js'));
  const originalIsPrivateOrReservedIP = pipeline.isPrivateOrReservedIP;

  // ==========================================================================
  // PUNTO 1 -- solo http:// y https://
  // ==========================================================================
  const rFtp = await pipeline.checkUrlReachable('ftp://example.com/archivo');
  check('1. ftp:// se rechaza (protocol-not-allowed)', rFtp.blocked === true && rFtp.reason === 'protocol-not-allowed', JSON.stringify(rFtp));

  const rFile = await pipeline.checkUrlReachable('file:///etc/passwd');
  check('1. file:// se rechaza (protocol-not-allowed)', rFile.blocked === true && rFile.reason === 'protocol-not-allowed', JSON.stringify(rFile));

  const rData = await pipeline.checkUrlReachable('data:text/plain;base64,aGk=');
  check('1. data: se rechaza (protocol-not-allowed o invalid-url)', rData.blocked === true, JSON.stringify(rData));

  const rGopher = await pipeline.checkUrlReachable('gopher://example.com/x');
  check('1. gopher:// se rechaza (protocol-not-allowed)', rGopher.blocked === true && rGopher.reason === 'protocol-not-allowed', JSON.stringify(rGopher));

  // ==========================================================================
  // PUNTO 2 -- rechazo de usuario/contraseña embebidos
  // ==========================================================================
  const rCreds1 = await pipeline.checkUrlReachable('https://user:pass@example.com/x');
  check('2. usuario+contraseña embebidos se rechaza (credentials-in-url)', rCreds1.blocked === true && rCreds1.reason === 'credentials-in-url', JSON.stringify(rCreds1));

  const rCreds2 = await pipeline.checkUrlReachable('https://onlyuser@example.com/x');
  check('2. solo usuario (sin contraseña) también se rechaza', rCreds2.blocked === true && rCreds2.reason === 'credentials-in-url', JSON.stringify(rCreds2));

  // ==========================================================================
  // PUNTO 3 / PUNTO 11.a / PUNTO 11.b -- bloqueo de direcciones privadas,
  // reservadas y de metadatos de nube (IPv4 e IPv6), sin necesidad de red
  // ==========================================================================
  const privateIPv4Cases = [
    ['http://localhost/x', 'localhost'],
    ['http://sub.localhost/x', 'subdominio de localhost'],
    ['http://127.0.0.1/x', '127.0.0.1 (loopback)'],
    ['http://127.55.1.2/x', '127.0.0.0/8 (cualquier loopback, no solo .1)'],
    ['http://0.0.0.0/x', '0.0.0.0'],
    ['http://10.0.0.5/x', '10.0.0.0/8 (privada clase A)'],
    ['http://172.16.0.5/x', '172.16.0.0/12 (privada clase B)'],
    ['http://172.31.255.254/x', '172.31.255.254 (límite superior de 172.16.0.0/12)'],
    ['http://192.168.1.1/x', '192.168.0.0/16 (privada clase C, router doméstico típico)'],
    ['http://169.254.169.254/x', '169.254.169.254 (endpoint de metadatos AWS/Azure/GCP)'],
    ['http://169.254.1.1/x', '169.254.0.0/16 (link-local)'],
    ['http://224.0.0.1/x', '224.0.0.0/4 (multicast)'],
    ['http://100.64.0.1/x', '100.64.0.0/10 (CGNAT, usado también como rango de metadatos en algunas nubes)'],
    ['http://192.0.2.1/x', '192.0.2.0/24 (TEST-NET, documentación)'],
    ['http://metadata.google.internal/x', 'hostname de metadatos de GCP'],
    ['http://metadata.goog/x', 'alias de metadatos de GCP']
  ];
  for (const [url, label] of privateIPv4Cases) {
    const r = await pipeline.checkUrlReachable(url);
    check('3. bloqueada: ' + label, r.blocked === true && r.reachable === false, JSON.stringify(r));
  }

  const privateIPv6Cases = [
    ['http://[::1]/x', '::1 (loopback IPv6)'],
    ['http://[::]/x', ':: (sin especificar)'],
    ['http://[fe80::1]/x', 'fe80::/10 (link-local IPv6)'],
    ['http://[fd12:3456:789a::1]/x', 'fd00::/8 (unique local / privada IPv6)'],
    ['http://[fc00::1]/x', 'fc00::/7 (unique local, mitad reservada)'],
    ['http://[ff02::1]/x', 'ff00::/8 (multicast IPv6)'],
    ['http://[::ffff:127.0.0.1]/x', '::ffff:127.0.0.1 (IPv4-mapped -> loopback embebido)'],
    ['http://[::ffff:169.254.169.254]/x', '::ffff:169.254.169.254 (IPv4-mapped -> metadatos de nube embebido)'],
    ['http://[::ffff:10.0.0.5]/x', '::ffff:10.0.0.5 (IPv4-mapped -> privada embebida)'],
    ['http://[64:ff9b::a00:1]/x', '64:ff9b::/96 (NAT64, embebe una IPv4 -- acá pública, igual se bloquea por rango NAT64)']
  ];
  for (const [url, label] of privateIPv6Cases) {
    const r = await pipeline.checkUrlReachable(url);
    check('3/11. bloqueada (IPv6): ' + label, r.blocked === true && r.reachable === false, JSON.stringify(r));
  }

  const rPublicLiteral = await pipeline.checkUrlReachable('http://8.8.8.8:1/x'); // IP pública real (DNS de Google) pero puerto cerrado -- solo prueba que NO se bloquea por ser "privada"
  check('3. una IP pública literal NO se bloquea por SSRF (puede fallar por otro motivo, pero no blocked:true)', rPublicLiteral.blocked !== true, JSON.stringify(rPublicLiteral));

  // Helpers puros expuestos -- confirmamos también a este nivel, no solo a
  // través de checkUrlReachable(), para dejar constancia de la lógica de
  // clasificación en sí (bitmask real, no regex de texto).
  check('3. isPrivateIPv4(169.254.169.254) === true (metadatos de nube)', pipeline.isPrivateIPv4('169.254.169.254') === true);
  check('3. isPrivateIPv4(8.8.8.8) === false (pública real)', pipeline.isPrivateIPv4('8.8.8.8') === false);
  check('3. isPrivateIPv6 detecta ::ffff:169.254.169.254 (mapeada) como privada', pipeline.isPrivateIPv6('::ffff:169.254.169.254') === true);
  check('3. isPrivateIPv6 detecta una IPv6 pública real (2001:4860:4860::8888, DNS de Google) como NO privada', pipeline.isPrivateIPv6('2001:4860:4860::8888') === false);
  check('3. isPrivateOrReservedIP bloquea por defecto algo que no es una IP reconocible', pipeline.isPrivateOrReservedIP('no-es-una-ip') === true);

  // ==========================================================================
  // A partir de acá hace falta un servidor real para seguir probando
  // (headers/status/redirects/timeouts) -- este entorno de pruebas no tiene
  // red pública, así que se usan servidores locales en 127.0.0.1. Como
  // 127.0.0.1 ahora se bloquea DE VERDAD (ver arriba), estas pruebas tratan
  // esa dirección puntual como si fuera pública SOLO acá adentro (se
  // restaura el clasificador real al final de esta sección) -- exactamente
  // el mismo mecanismo, y la misma justificación, que ya se usa en
  // test-source-provenance.js. Esto NO relaja la protección real: fuera de
  // este bloque, y en producción, 127.0.0.1 sigue bloqueada.
  // ==========================================================================
  pipeline.isPrivateOrReservedIP = function (ip) {
    if (ip === '127.0.0.1') return false;
    return originalIsPrivateOrReservedIP(ip);
  };

  // ==========================================================================
  // PUNTO 9 / PUNTO 11.g / PUNTO 11.h -- taxonomía de status codes
  // ==========================================================================
  const statusServer = http.createServer(function (req, res) {
    if (req.url === '/404') { res.writeHead(404); return res.end(); }
    if (req.url === '/410') { res.writeHead(410); return res.end(); }
    if (req.url === '/401') { res.writeHead(401); return res.end(); }
    if (req.url === '/403') { res.writeHead(403); return res.end(); }
    if (req.url === '/429') { res.writeHead(429); return res.end(); }
    if (req.url === '/500') { res.writeHead(500); return res.end(); }
    if (req.url === '/503') { res.writeHead(503); return res.end(); }
    if (req.url === '/200') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(200); res.end();
  });
  await new Promise(function (resolve) { statusServer.listen(0, '127.0.0.1', resolve); });
  const statusPort = statusServer.address().port;
  const statusBase = 'http://127.0.0.1:' + statusPort;

  const r404 = await pipeline.checkUrlReachable(statusBase + '/404');
  check('9. 404 -> reachable:false (fuente inexistente), sin uncertain', r404.reachable === false && !r404.uncertain, JSON.stringify(r404));
  const r410 = await pipeline.checkUrlReachable(statusBase + '/410');
  check('9. 410 -> reachable:false (fuente inexistente), sin uncertain', r410.reachable === false && !r410.uncertain, JSON.stringify(r410));

  const r401 = await pipeline.checkUrlReachable(statusBase + '/401');
  check('9/11.g. 401 -> uncertain:true, NUNCA reachable:false', r401.uncertain === true && r401.reachable !== false, JSON.stringify(r401));
  const r403 = await pipeline.checkUrlReachable(statusBase + '/403');
  check('9/11.g. 403 -> uncertain:true, NUNCA reachable:false', r403.uncertain === true && r403.reachable !== false, JSON.stringify(r403));
  const r429 = await pipeline.checkUrlReachable(statusBase + '/429');
  check('9/11.h. 429 -> uncertain:true, NUNCA reachable:false', r429.uncertain === true && r429.reachable !== false, JSON.stringify(r429));
  const r500 = await pipeline.checkUrlReachable(statusBase + '/500');
  check('9. 500 -> uncertain:true, NUNCA reachable:false', r500.uncertain === true && r500.reachable !== false, JSON.stringify(r500));
  const r503 = await pipeline.checkUrlReachable(statusBase + '/503');
  check('9. 503 -> uncertain:true, NUNCA reachable:false', r503.uncertain === true && r503.reachable !== false, JSON.stringify(r503));
  const r200 = await pipeline.checkUrlReachable(statusBase + '/200');
  check('9. 200 -> reachable:true, sin uncertain', r200.reachable === true && !r200.uncertain, JSON.stringify(r200));

  await new Promise(function (resolve) { statusServer.close(resolve); });

  // ==========================================================================
  // PUNTO 7 -- HEAD primero; si no está permitido (405/401/403 a HEAD),
  // reintenta con GET antes de concluir nada -- y en ningún caso se lee el
  // cuerpo completo (ver PUNTO 6/8/11.f más abajo, con respuesta gigante)
  // ==========================================================================
  let sawHeadFirst = false, sawGetFallback = false;
  const headServer = http.createServer(function (req, res) {
    if (req.method === 'HEAD') { sawHeadFirst = true; res.writeHead(405); return res.end(); }
    if (req.method === 'GET') { sawGetFallback = true; res.writeHead(200); return res.end('solo via get'); }
    res.writeHead(500); res.end();
  });
  await new Promise(function (resolve) { headServer.listen(0, '127.0.0.1', resolve); });
  const headPort = headServer.address().port;
  const rHead = await pipeline.checkUrlReachable('http://127.0.0.1:' + headPort + '/x');
  check('7. primero intenta HEAD', sawHeadFirst === true);
  check('7. si HEAD no está permitido, reintenta con GET', sawGetFallback === true);
  check('7. después del fallback GET, concluye reachable:true', rHead.reachable === true, JSON.stringify(rHead));
  await new Promise(function (resolve) { headServer.close(resolve); });

  // ==========================================================================
  // PUNTO 6 / PUNTO 8 / PUNTO 11.f -- nunca se descarga un archivo
  // completo: una respuesta "gigante" (en la práctica, infinita: el
  // servidor nunca deja de mandar datos) no debe demorar la respuesta ni
  // hacer que el proceso de prueba consuma memoria -- checkUrlReachable
  // debe resolver ni bien llegan los headers, sin esperar el cuerpo.
  // ==========================================================================
  // Nota sobre el diseño de este servidor de prueba: la respuesta gigante
  // se manda como reacción al GET de FALLBACK (HEAD se rechaza con 405 a
  // propósito) en vez de a un HEAD directo. Esto es a propósito y no un
  // atajo: para un método HEAD, Node.js nunca llega a mandar ni siquiera
  // los headers al socket si el handler jamás llama a res.end() (detalle
  // de implementación de _http_outgoing, no algo controlable desde
  // checkUrlReachable) -- con lo cual un HEAD-que-nunca-termina ya queda
  // cubierto, de forma indistinguible y correcta, por el escenario de
  // "timeout" probado más abajo (6/11.e). El escenario realmente distinto
  // que hace falta cubrir acá es el de un servidor que SÍ manda headers
  // completos (200) para el GET de fallback y después no para de mandar
  // cuerpo -- ahí es donde importa de verdad que checkUrlReachable corte
  // la conexión ni bien ve los headers, sin esperar el cuerpo.
  let bytesServerSentBeforeDestroy = 0;
  let clientAborted = false;
  const hugeServer = http.createServer(function (req, res) {
    if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 65); // 64KB de "A"s
    const interval = setInterval(function () {
      if (res.destroyed) { clientAborted = true; clearInterval(interval); return; }
      bytesServerSentBeforeDestroy += chunk.length;
      res.write(chunk);
    }, 20);
    res.on('close', function () { clearInterval(interval); clientAborted = true; });
  });
  await new Promise(function (resolve) { hugeServer.listen(0, '127.0.0.1', resolve); });
  const hugePort = hugeServer.address().port;
  const hugeStart = Date.now();
  const rHuge = await pipeline.checkUrlReachable('http://127.0.0.1:' + hugePort + '/x');
  const hugeElapsedMs = Date.now() - hugeStart;
  check('6/8/11.f. una respuesta que nunca termina de mandar datos igual resuelve rápido (sin esperar el cuerpo)', hugeElapsedMs < 3000, hugeElapsedMs + 'ms, resultado=' + JSON.stringify(rHuge));
  check('6/8/11.f. el resultado es reachable:true (status 200 visto en headers, sin leer el cuerpo)', rHuge.reachable === true, JSON.stringify(rHuge));
  await sleep(200); // le da tiempo al server a notar que el cliente cortó
  check('6/8/11.f. la conexión se cortó del lado del cliente ni bien se vieron los headers (no se leyó el cuerpo completo)', clientAborted === true);
  await new Promise(function (resolve) { hugeServer.close(resolve); });

  // ==========================================================================
  // PUNTO 6 / PUNTO 11.e -- timeout (servidor que acepta la conexión pero
  // nunca contesta nada)
  // ==========================================================================
  const hangingServer = http.createServer(function () { /* nunca responde */ });
  await new Promise(function (resolve) { hangingServer.listen(0, '127.0.0.1', resolve); });
  const hangingPort = hangingServer.address().port;
  const timeoutStart = Date.now();
  const rTimeout = await pipeline.checkUrlReachable('http://127.0.0.1:' + hangingPort + '/x');
  const timeoutElapsedMs = Date.now() - timeoutStart;
  check('6/11.e. un servidor que nunca contesta resuelve como uncertain (timeout), no como reachable:false', rTimeout.uncertain === true && rTimeout.reachable !== false, JSON.stringify(rTimeout));
  check('6/11.e. el timeout corta en un tiempo acotado (no cuelga la revisión)', timeoutElapsedMs < 15000, timeoutElapsedMs + 'ms');
  await new Promise(function (resolve) { hangingServer.close(resolve); });

  // ==========================================================================
  // PUNTO 6 / PUNTO 11.d -- límite de redirecciones
  // ==========================================================================
  let redirectHops = 0;
  const redirectLoopServer = http.createServer(function (req, res) {
    redirectHops++;
    res.writeHead(302, { Location: '/siguiente-' + redirectHops });
    res.end();
  });
  await new Promise(function (resolve) { redirectLoopServer.listen(0, '127.0.0.1', resolve); });
  const redirectLoopPort = redirectLoopServer.address().port;
  redirectHops = 0;
  const rTooManyRedirects = await pipeline.checkUrlReachable('http://127.0.0.1:' + redirectLoopPort + '/inicio');
  check('6/11.d. una cadena de redirecciones infinita se corta (too-many-redirects), no cuelga', rTooManyRedirects.uncertain === true && rTooManyRedirects.error === 'too-many-redirects', JSON.stringify(rTooManyRedirects));
  check('6/11.d. el número de saltos reales quedó acotado (no siguió indefinidamente)', redirectHops > 0 && redirectHops <= 10, 'hops=' + redirectHops);
  await new Promise(function (resolve) { redirectLoopServer.close(resolve); });

  // ==========================================================================
  // PUNTO 5 / PUNTO 11.c -- redirección de una URL "pública" a una
  // dirección privada: la re-validación tiene que agarrarla en el
  // segundo salto, no confiar en que el primero ya pasó.
  //
  // Mecanismo de simulación (documentado a propósito, porque no hay red
  // pública real disponible en este entorno): el primer servidor escucha
  // en 127.0.0.1, que ya está tratada como "pública" SOLO dentro de este
  // archivo de pruebas (ver más arriba). El segundo salto (el redirect)
  // apunta a 127.0.0.2 -- otra dirección de loopback real, pero que NO
  // está en la lista de excepciones de arriba, así que pasa por la
  // clasificación REAL (sin parchear) y se identifica correctamente como
  // privada (127.0.0.0/8). Esto prueba exactamente la propiedad pedida:
  // el chequeo de IP se repite de forma independiente en cada salto, y no
  // hereda la confianza del salto anterior.
  // ==========================================================================
  const redirectToPrivateServer = http.createServer(function (req, res) {
    res.writeHead(302, { Location: 'http://127.0.0.2:65535/interno' });
    res.end();
  });
  await new Promise(function (resolve) { redirectToPrivateServer.listen(0, '127.0.0.1', resolve); });
  const redirectToPrivatePort = redirectToPrivateServer.address().port;
  const rRedirectToPrivate = await pipeline.checkUrlReachable('http://127.0.0.1:' + redirectToPrivatePort + '/publico-que-redirige');
  check('5/11.c. redirección pública(simulada)->privada: el destino se bloquea (nunca se conecta)', rRedirectToPrivate.blocked === true && rRedirectToPrivate.reachable === false, JSON.stringify(rRedirectToPrivate));
  check('5/11.c. el motivo del bloqueo es "private-address" (no otra cosa)', rRedirectToPrivate.reason === 'private-address', JSON.stringify(rRedirectToPrivate));
  await new Promise(function (resolve) { redirectToPrivateServer.close(resolve); });

  // Redirección pública(simulada)->pública(simulada): SÍ debe seguirse.
  const redirectToOkServer = http.createServer(function (req, res) {
    if (req.url === '/publico-que-redirige-a-otro-publico') {
      res.writeHead(302, { Location: 'http://127.0.0.1:' + redirectToOkServer.address().port + '/destino-final' });
      return res.end();
    }
    res.writeHead(200); res.end('ok');
  });
  await new Promise(function (resolve) { redirectToOkServer.listen(0, '127.0.0.1', resolve); });
  const rRedirectToOk = await pipeline.checkUrlReachable('http://127.0.0.1:' + redirectToOkServer.address().port + '/publico-que-redirige-a-otro-publico');
  check('5. redirección pública(simulada)->pública(simulada) SÍ se sigue normalmente', rRedirectToOk.reachable === true && !rRedirectToOk.blocked, JSON.stringify(rRedirectToOk));
  await new Promise(function (resolve) { redirectToOkServer.close(resolve); });

  pipeline.isPrivateOrReservedIP = originalIsPrivateOrReservedIP; // fin de la sección con el bypass de prueba

  // ==========================================================================
  // PUNTO 8 -- nunca se registran cuerpos/cookies/credenciales: se prueba
  // indirectamente (arriba, con res.destroy() antes de leer cuerpo) más
  // una revisión estática de que checkUrlReachable/attemptFetch no llaman
  // a console.log/console.error con nada que incluya el cuerpo o headers
  // de la respuesta, y de que no se reenvían cookies de una respuesta a la
  // siguiente petición (cada salto es una conexión nueva, sin jar de
  // cookies -- http.request no persiste cookies entre llamadas por
  // diseño, así que no hace falta código extra para esto).
  // ==========================================================================
  const pipelineSrc = fs.readFileSync(path.join(adminDir, 'pipeline.js'), 'utf8');
  const checkUrlSection = pipelineSrc.slice(pipelineSrc.indexOf('function safeLookup'), pipelineSrc.indexOf('function checkUrlReachable') + 500);
  check('8. la sección de red de checkUrlReachable no llama a console.* (no puede loguear cuerpo/cookies/credenciales)', !/console\.(log|error|warn|info)/.test(checkUrlSection), 'match encontrado');
  check('8. no se guarda res.headers[\'set-cookie\'] en ningún lado de esta sección', !/set-cookie/i.test(checkUrlSection));

  // ==========================================================================
  // PUNTO 10 / PUNTO 11 (canonicalización) -- solo tracking, nunca
  // parámetros funcionales
  // ==========================================================================
  check('10. utm_* se elimina', feeds.canonicalizeUrl('https://x.com/a?utm_source=rss&id=1') === 'https://x.com/a?id=1');
  check('10. fbclid se elimina', feeds.canonicalizeUrl('https://x.com/a?fbclid=abc&id=1') === 'https://x.com/a?id=1');
  check('10. gclid se elimina', feeds.canonicalizeUrl('https://x.com/a?gclid=abc&id=1') === 'https://x.com/a?id=1');
  check('10. msclkid se elimina', feeds.canonicalizeUrl('https://x.com/a?msclkid=abc&id=1') === 'https://x.com/a?id=1');
  // Parámetros FUNCIONALES conocidos que una versión anterior de esta
  // lista corría el riesgo de borrar -- tienen que sobrevivir intactos.
  check('10. "ref" (parámetro funcional en muchos sitios, ej. GitHub raw ?ref=<rama>) NO se elimina', feeds.canonicalizeUrl('https://raw.githubusercontent.com/org/repo/x?ref=main') === 'https://raw.githubusercontent.com/org/repo/x?ref=main');
  check('10. "id" (parámetro funcional genérico) NO se elimina', feeds.canonicalizeUrl('https://x.com/a?id=42') === 'https://x.com/a?id=42');
  check('10. "page"/"lang" (parámetros funcionales genéricos) NO se eliminan', feeds.canonicalizeUrl('https://x.com/a?page=2&lang=es') === 'https://x.com/a?lang=es&page=2');

  // ==========================================================================
  // PUNTO 4 -- DNS se resuelve y se valida ANTES de conectar, con la MISMA
  // IP que después se usa para conectar (opción `lookup`, no hay ventana
  // de rebinding). Se prueba indirectamente: monkeypatcheamos dns.lookup
  // para devolver una IP privada de verdad, y confirmamos que ni siquiera
  // se intenta una conexión TCP (se bloquea antes).
  // ==========================================================================
  const dns = require('dns');
  const originalDnsLookup = dns.lookup;
  let tcpConnectAttempted = false;
  const originalNetConnect = net.connect;
  net.connect = function () { tcpConnectAttempted = true; return originalNetConnect.apply(net, arguments); };
  dns.lookup = function (hostname, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (hostname === 'noticia-de-mentira.test') {
      var addrs = [{ address: '10.1.2.3', family: 4 }];
      if (opts && opts.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    }
    return originalDnsLookup.call(dns, hostname, opts, cb);
  };
  const rDnsRebind = await pipeline.checkUrlReachable('http://noticia-de-mentira.test/x');
  check('4. un hostname que resuelve por DNS a una IP privada se bloquea ANTES de conectar', rDnsRebind.blocked === true && rDnsRebind.reachable === false, JSON.stringify(rDnsRebind));
  check('4. nunca se llegó a intentar una conexión TCP real (se cortó en la validación de DNS)', tcpConnectAttempted === false);
  dns.lookup = originalDnsLookup;
  net.connect = originalNetConnect;

  // ==========================================================================
  // PUNTO 12 -- keyClaims etiquetadas como "extraídas automáticamente para
  // revisión", no como hechos ya verificados (chequeo del texto real que
  // ve el editor en el panel)
  // ==========================================================================
  const adminJsSrc = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
  check('12. admin.js etiqueta las afirmaciones principales como "extraídas automáticamente para revisión"', /extra[ií]das autom[aá]ticamente para revisi[oó]n/i.test(adminJsSrc), 'no se encontró el texto esperado');
  check('12. esa etiqueta aclara explícitamente que NO están verificadas', /no verificadas/i.test(adminJsSrc));

  // ==========================================================================
  // PUNTO 2 (server.js) -- /api/check-source usa el mismo checkUrlReachable
  // endurecido, así que hereda automáticamente todas las protecciones de
  // arriba -- se confirma con un servidor real spawneado, contra una URL
  // privada literal (debe volver blocked:true, nunca intentar conectar).
  // ==========================================================================
  const PORT = 4331; // puerto propio, distinto de las demás suites
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
      return sleep(150).then(function () { return waitForServer(url, tries - 1); });
    });
  }
  await waitForServer('http://127.0.0.1:' + PORT + '/');

  const apiRes = await fetch('http://127.0.0.1:' + PORT + '/api/check-source?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'));
  const apiJson = await apiRes.json();
  check('/api/check-source bloquea el endpoint de metadatos de nube igual que checkUrlReachable', apiJson.blocked === true && apiJson.reachable === false, JSON.stringify(apiJson));

  const apiRes2 = await fetch('http://127.0.0.1:' + PORT + '/api/check-source?url=' + encodeURIComponent('https://user:pass@example.com/x'));
  const apiJson2 = await apiRes2.json();
  check('/api/check-source rechaza credenciales embebidas', apiJson2.blocked === true && apiJson2.reason === 'credentials-in-url', JSON.stringify(apiJson2));

  child.kill();
  await sleep(300);

  // ==========================================================================
  // Regresión: nada de esto tocó el sitio real
  // ==========================================================================
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('regresión. data/articulos.json del sitio real no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('regresión. El sitio real (sandbox) sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos, sin cambios (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('regresión. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL:', e);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
