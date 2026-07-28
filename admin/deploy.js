/*
  Publicar cambios (git add + commit + push) — compartido entre
  POST /api/deploy (admin/server.js, botón "Publicar cambios en
  internet") y admin/auto-publish.js (el bot de publicación
  automática). Misma lógica en los dos casos: si no hay nada para
  commitear, no falla, solo avisa.
*/

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

// "paths": opcional. Sin especificar, hace "git add -A" (todo lo que
// haya cambiado) — es lo que usa el botón manual "Publicar cambios",
// donde el usuario ya sabe qué tiene pendiente. admin/auto-publish.js
// SIEMPRE pasa una lista explícita de paths (solo lo que el bot mismo
// pudo haber tocado) para no arrastrar cambios sueltos sin relación
// que puedan estar en el repo en ese momento (código a medio hacer,
// imágenes que el usuario todavía no quiere subir, etc.).
async function deploy(commitMessage, paths) {
  var add = await runGit(['add'].concat(paths && paths.length ? paths : ['-A']));
  var commit = await runGit(['commit', '-m', commitMessage]);
  var nothingToCommit = commit.output.toLowerCase().indexOf('nothing to commit') !== -1;
  if (nothingToCommit) {
    return { ok: true, nothingToCommit: true, output: 'No había cambios nuevos para publicar.' };
  }
  var push = await runGit(['push', 'origin', 'main']);
  var full = '--- git add ---\n' + add.output + '\n--- git commit ---\n' + commit.output + '\n--- git push ---\n' + push.output;
  return { ok: push.code === 0, nothingToCommit: false, output: full };
}

module.exports = { deploy: deploy };
