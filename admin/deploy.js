/*
  Publicar cambios (git add + commit + push) — usado por
  POST /api/deploy (admin/server.js, botón "Publicar cambios en
  internet"). Si no hay nada para commitear, no falla, solo avisa.

  Protección permanente del panel, sección 7 (sept. 2026): "Si falla algo
  crítico, debe salir con código distinto de cero y bloquear el botón
  'Publicar cambios'." Antes este botón solo hacía git add/commit/push
  sin ningún control propio -- confiaba en que cada guardado individual
  (POST /api/articles) ya hubiera bloqueado lo que tenía que bloquear.
  Eso deja huecos: un archivo tocado a mano fuera del panel, un estado
  inconsistente entre dos guardados, una regresión de paridad Node/Python
  que ningún guardado individual detecta. Ahora, antes de tocar git,
  corre `npm run validate:publish` (admin/validate-publish.js) -- el
  chequeo único que audita TODO de una vez (esquema, fuentes, licencias,
  sitemap, AdSense, SEO, enlaces rotos, paridad, determinismo, secretos,
  sintaxis) -- y si algo crítico falla, el deploy se corta ACÁ, sin
  ejecutar ni "git add" siquiera.
*/

const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN_DIR = __dirname;

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

function runValidatePublish() {
  return new Promise(function (resolve) {
    execFile(process.execPath, [path.join(ADMIN_DIR, 'validate-publish.js')], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, function (err, stdout, stderr) {
      resolve({ ok: !err, output: (stdout || '') + (stderr || '') });
    });
  });
}

// "paths": opcional. Sin especificar, hace "git add -A" (todo lo que
// haya cambiado) — es lo que usa el botón manual "Publicar cambios",
// donde el usuario ya sabe qué tiene pendiente.
async function deploy(commitMessage, paths) {
  var validation = await runValidatePublish();
  if (!validation.ok) {
    return {
      ok: false,
      blockedByValidation: true,
      nothingToCommit: false,
      error: 'validacion_bloqueada',
      message: 'Publicación bloqueada: npm run validate:publish encontró al menos un control crítico fallido. No se ejecutó ningún comando git.',
      output: validation.output
    };
  }

  var add = await runGit(['add'].concat(paths && paths.length ? paths : ['-A']));
  var commit = await runGit(['commit', '-m', commitMessage]);
  var nothingToCommit = commit.output.toLowerCase().indexOf('nothing to commit') !== -1;
  if (nothingToCommit) {
    return { ok: true, nothingToCommit: true, output: 'No había cambios nuevos para publicar.' };
  }
  var push = await runGit(['push', 'origin', 'main']);
  var full = '--- validate:publish ---\nOK\n--- git add ---\n' + add.output + '\n--- git commit ---\n' + commit.output + '\n--- git push ---\n' + push.output;
  return { ok: push.code === 0, nothingToCommit: false, output: full };
}

module.exports = { deploy: deploy };
