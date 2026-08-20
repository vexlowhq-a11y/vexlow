/*
  Sprint de @vexlowhq — usado por admin/server.js
  ==============================================================
  Junta el plan fijo (data/sprint-plan.json, el guion día por día)
  con el progreso real (data/sprint-log.json, que arranca vacío hasta
  que el usuario toca "Iniciar sprint"). No publica nada por sí solo:
  el panel arma todo y el usuario confirma cada pieza, tal como pidió.
*/

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PLAN_PATH = path.join(DATA_DIR, 'sprint-plan.json');
const LOG_PATH = path.join(DATA_DIR, 'sprint-log.json');

function loadPlan() {
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function loadLog() {
  try {
    var data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    if (!data.days) data.days = {};
    return data;
  } catch (e) {
    return { startDate: null, days: {} };
  }
}

function saveLog(data) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function startSprint() {
  var log = loadLog();
  if (!log.startDate) log.startDate = new Date().toISOString().slice(0, 10);
  saveLog(log);
  return log;
}

function resetSprint() {
  var log = { startDate: null, days: {} };
  saveLog(log);
  return log;
}

// Día 1..N según cuántos días pasaron desde el inicio -- si el
// sprint no arrancó todavía, no hay "día actual". N sale de la
// cantidad de días real del plan cargado (no hardcodeado), para que
// no haya que tocar este archivo cada vez que cambia el largo del
// sprint.
function currentDayNumber(log, totalDays) {
  if (!log.startDate) return null;
  var start = new Date(log.startDate + 'T00:00:00');
  var today = new Date();
  var diffDays = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
    Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
  var day = diffDays + 1;
  if (day < 1) return 1;
  if (day > totalDays) return totalDays;
  return day;
}

function kpiVerdict(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return null;
  if (pct < 30) {
    return { level: 'bad', message: 'El gancho no funcionó. Mañana cambiá el gancho, no el tema.' };
  }
  if (pct < 60) {
    return { level: 'mid', message: 'El algoritmo lo está probando con un grupo chico. Mantené el formato, seguí publicando.' };
  }
  return { level: 'good', message: 'Encontraste una fórmula que funciona. Repetí esa estructura de gancho con un tema nuevo mañana.' };
}

function markDayDone(day, info) {
  var log = loadLog();
  var key = String(day);
  log.days[key] = Object.assign({}, log.days[key], info, { completedAt: new Date().toISOString() });
  saveLog(log);
  return log.days[key];
}

function toggleStory(day, index) {
  var log = loadLog();
  var key = String(day);
  var entry = log.days[key] || {};
  var storiesDone = entry.storiesDone || [];
  var i = storiesDone.indexOf(index);
  if (i === -1) storiesDone.push(index); else storiesDone.splice(i, 1);
  entry.storiesDone = storiesDone;
  log.days[key] = entry;
  saveLog(log);
  return entry;
}

function saveKpi(day, pct) {
  var log = loadLog();
  var key = String(day);
  var entry = log.days[key] || {};
  entry.nonFollowerReachPct = pct;
  log.days[key] = entry;
  saveLog(log);
  return { entry: entry, verdict: kpiVerdict(pct) };
}

// Vista combinada para el panel: plan + progreso + día actual, con el
// veredicto de KPI ya calculado si hay dato cargado.
function getStatus() {
  var plan = loadPlan();
  var log = loadLog();
  var currentDay = currentDayNumber(log, plan.days.length);
  var days = plan.days.map(function (d) {
    var entry = log.days[String(d.day)] || {};
    return Object.assign({}, d, {
      done: !!entry.completedAt,
      storiesDone: entry.storiesDone || [],
      nonFollowerReachPct: entry.nonFollowerReachPct != null ? entry.nonFollowerReachPct : null,
      kpiVerdict: kpiVerdict(entry.nonFollowerReachPct),
      postUrl: entry.postUrl || null,
      mediaId: entry.mediaId || null
    });
  });
  return {
    name: plan.name,
    accounts: plan.accounts,
    startDate: log.startDate,
    currentDay: currentDay,
    days: days
  };
}

module.exports = {
  loadPlan: loadPlan,
  loadLog: loadLog,
  startSprint: startSprint,
  resetSprint: resetSprint,
  markDayDone: markDayDone,
  toggleStory: toggleStory,
  saveKpi: saveKpi,
  kpiVerdict: kpiVerdict,
  getStatus: getStatus
};
