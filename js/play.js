/*
  Trivia diaria de VexlowHQ (play/index.html). Todos los visitantes ven
  la misma pregunta el mismo día (se elige por número de día desde epoch,
  sin necesidad de servidor). El resultado ("acertaste o no", la racha)
  se guarda en localStorage; el porcentaje de aciertos del día se guarda
  en Redis vía api/trivia.js, igual que las reacciones de los artículos.
*/
(function () {
  var root = document.getElementById('triviaGame');
  if (!root) return;

  function dayNumber() {
    return Math.floor(Date.now() / 86400000);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getVisitorId() {
    var id = null;
    try {
      id = localStorage.getItem('vexlow_vid');
      if (!id) {
        id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem('vexlow_vid', id);
      }
    } catch (e) { /* localStorage no disponible */ }
    return id;
  }

  fetch('../data/trivia.json')
    .then(function (r) { return r.json(); })
    .then(init)
    .catch(function () {
      root.innerHTML = '<p class="admin-hint">Couldn\'t load today\'s question. Try again in a bit.</p>';
    });

  function init(pool) {
    var day = dayNumber();
    var q = pool[day % pool.length];
    var visitorId = getVisitorId();

    var state = {};
    try { state = JSON.parse(localStorage.getItem('vexlow_trivia_state') || '{}'); } catch (e) {}

    var alreadyPlayedToday = state.lastDay === day;

    root.innerHTML =
      '<div class="trivia-card">' +
      '<span class="trivia-category">' + escapeHtml(q.category) + '</span>' +
      '<h2 class="trivia-question">' + escapeHtml(q.question) + '</h2>' +
      '<div class="trivia-options">' +
      q.options.map(function (opt, i) {
        return '<button type="button" class="trivia-option" data-index="' + i + '">' + escapeHtml(opt) + '</button>';
      }).join('') +
      '</div>' +
      '<div class="trivia-result" hidden></div>' +
      '<div class="trivia-stats" id="triviaStats">Loading today\'s stats…</div>' +
      '<div class="trivia-streak">🔥 Streak: <strong id="triviaStreakValue">' + (state.streak || 0) + '</strong> day(s) in a row</div>' +
      '</div>';

    var resultBox = root.querySelector('.trivia-result');

    function lockOptions(chosenIndex) {
      root.querySelectorAll('.trivia-option').forEach(function (btn, i) {
        btn.disabled = true;
        if (i === q.answerIndex) btn.classList.add('correct');
        else if (i === chosenIndex) btn.classList.add('incorrect');
      });
    }

    function showResult(isCorrect) {
      resultBox.hidden = false;
      resultBox.className = 'trivia-result ' + (isCorrect ? 'is-correct' : 'is-incorrect');
      resultBox.innerHTML = (isCorrect ? '✅ Correct! ' : '❌ Not quite. ') + escapeHtml(q.funFact || '') +
        '<div class="trivia-next">Come back tomorrow for a new question.</div>';
    }

    function paintStats(stats) {
      var el = document.getElementById('triviaStats');
      if (!el || !stats) return;
      var total = stats.correct + stats.incorrect;
      if (total === 0) { el.textContent = 'Be the first to answer today!'; return; }
      var pct = Math.round((stats.correct / total) * 100);
      el.textContent = pct + '% of ' + total + ' reader' + (total === 1 ? '' : 's') + ' got today\'s question right.';
    }

    function loadStats() {
      fetch('/api/trivia?day=' + day)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(paintStats)
        .catch(function () {});
    }

    if (alreadyPlayedToday) {
      lockOptions(state.lastAnswerIndex);
      showResult(!!state.lastCorrect);
      loadStats();
      return;
    }

    root.querySelectorAll('.trivia-option').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-index'), 10);
        var isCorrect = idx === q.answerIndex;
        lockOptions(idx);
        showResult(isCorrect);

        var newStreak = (state.lastDay === day - 1) ? (state.streak || 0) + 1 : 1;
        state = { lastDay: day, streak: newStreak, lastAnswerIndex: idx, lastCorrect: isCorrect };
        try { localStorage.setItem('vexlow_trivia_state', JSON.stringify(state)); } catch (e) {}
        var streakEl = document.getElementById('triviaStreakValue');
        if (streakEl) streakEl.textContent = newStreak;

        if (!visitorId) return;
        fetch('/api/trivia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: day, correct: isCorrect, visitorId: visitorId })
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(paintStats)
          .catch(function () {});
      });
    });

    loadStats();
  }
})();
