/*
  Redacción automática de borradores — usado por admin/server.js
  =================================================================
  Toma un ítem de un feed RSS (título + resumen + link del original)
  y le pide a un modelo de IA que redacte un artículo ORIGINAL en el
  estilo de VexlowHQ, inspirado en esa noticia pero sin copiar el
  texto fuente. El resultado queda como borrador — no se publica
  solo, alguien lo tiene que revisar y guardar desde el panel.

  Soporta dos proveedores, elegidos por "draftProvider" en
  admin/config.json ("openai" u "anthropic"), cada uno con su propia
  API key ("openaiApiKey" / "anthropicApiKey").
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function extractJson(text) {
  var trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch (e) { /* sigue abajo */ }
  var match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e2) { /* sigue abajo */ }
  }
  throw new Error('La respuesta de la IA no vino en JSON válido');
}

// Metadata técnica de la llamada (pedido de Leonardo, 2026-09-27, punto 6):
// SOLO campos de diagnóstico no sensibles -- nunca el prompt completo, nunca
// la respuesta cruda, nunca ninguna clave. Sirve para poder distinguir a
// futuro un truncamiento real (finishReason/stopReason indicando el límite
// de tokens) de una decisión del propio modelo de escribir menos -- ver
// admin/pipeline.js:validateDraftWritingQuality(), que la usa SOLO para
// detectar truncamiento (nunca para decidir "listo"/"revisar" por sí sola,
// salvo ese caso puntual).
function buildAiCallMeta(provider, model, finishReason, usage) {
  return {
    provider: provider,
    model: model,
    finishReason: finishReason || null,
    truncated: finishReason === 'length' || finishReason === 'max_tokens',
    inputTokens: (usage && typeof usage.inputTokens === 'number') ? usage.inputTokens : null,
    outputTokens: (usage && typeof usage.outputTokens === 'number') ? usage.outputTokens : null
  };
}

function callAnthropic(apiKey, model, systemPrompt, userPrompt) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify({
      model: model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload)
      }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error('Anthropic API respondió ' + res.statusCode + ': ' + body.slice(0, 300)));
        }
        try {
          var parsed = JSON.parse(body);
          var text = (parsed.content || []).map(function (b) { return b.text || ''; }).join('');
          var meta = buildAiCallMeta('anthropic', model, parsed.stop_reason, {
            inputTokens: parsed.usage && parsed.usage.input_tokens,
            outputTokens: parsed.usage && parsed.usage.output_tokens
          });
          resolve({ text: text, meta: meta });
        } catch (e) {
          reject(new Error('No se pudo leer la respuesta de Anthropic: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callOpenAI(apiKey, model, systemPrompt, userPrompt) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    var req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + apiKey,
        'content-length': Buffer.byteLength(payload)
      }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error('OpenAI API respondió ' + res.statusCode + ': ' + body.slice(0, 300)));
        }
        try {
          var parsed = JSON.parse(body);
          var choice = (parsed.choices && parsed.choices[0]) || {};
          var text = (choice.message && choice.message.content) || '';
          var meta = buildAiCallMeta('openai', model, choice.finish_reason, {
            inputTokens: parsed.usage && parsed.usage.prompt_tokens,
            outputTokens: parsed.usage && parsed.usage.completion_tokens
          });
          resolve({ text: text, meta: meta });
        } catch (e) {
          reject(new Error('No se pudo leer la respuesta de OpenAI: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

var SYSTEM_PROMPT = [
  'You are a news writer for VexlowHQ, an internet culture / tech / gaming / AI / general news discovery site for a US audience.',
  'You will be given a headline, a short summary, and a source link from another outlet (sometimes with one or more additional corroborating sources that also covered the same story). Write an ORIGINAL article inspired by that story — never copy or closely paraphrase the source wording. Rewrite entirely in your own words and structure.',
  'Stay strictly factual: only use information present in the given headline/summary. Never invent quotes, statistics, dates, scores, venues, host cities/countries, or any other specific proper noun or number that was not explicitly provided — even ones that sound plausible or that you "know" from general knowledge, since the summary may be incomplete or about a fast-changing situation and a wrong specific detail is worse than a vaguer sentence. If you are not 100% certain a specific fact was in the source, phrase that sentence generically instead (e.g. "the host venue" instead of naming one) rather than guessing.',
  'This must read as a substantive, in-depth article, not a rewritten summary of the headline. Beyond the bare facts given, you are expected to add real editorial value: background/context on the people, companies or technology involved, how this fits into the broader trend or history of the topic, what similar past events or competing products looked like, what questions remain open, and what the likely implications are for readers, the industry, or the market. This context must stay at the level of general, safe-to-assert framing (e.g. widely-known history of a franchise or company) — never introduce a new specific fact (a date, a place, a number, a name) that is not in the given headline/summary.',
  'Tone: neutral, journalistic, engaging — matching a professional online news outlet, but with a distinct voice: it is fine to note what stands out, what seems surprising, or what the likely stakes are, as long as every such observation stays a fair reading of the facts given, not a fabricated detail. Aim for 700-1000 words when the sources support it; do not pad with repetition or filler to hit the count — every paragraph should add a genuinely new angle, fact-adjacent context, or implication. If the sources are too thin to responsibly reach that length without repeating yourself or inventing detail, write a shorter, honest piece instead — a short, well-sourced article is always better than a padded one.',
  'CRITICAL — avoid formulaic structure: do not default to generic, interchangeable subheadings like "Overview", "Looking Ahead", "Conclusion", "Future Outlook", "Future Considerations", "The Competitive Landscape", "What Lies Ahead", "Looking Forward", "The Road Ahead", "The Broader Implications", or similar catch-all phrases — these read as templated filler across many articles. Every subheading must be specific to what that section actually says about THIS story (name the actual person/product/event/angle), not a generic label that could be pasted into any other article on any other topic.',
  '',
  'ATTRIBUTION (mandatory — this is a hard requirement, not a style suggestion): you will be given the real name and URL of the primary source, and of any additional corroborating sources, in the "Sources available" block below. Every figure, date, quote, job title/role, accusation, or forward-looking plan you state MUST be attributed inline to whichever of those sources it came from, written as real embedded HTML links in this exact format: <a href="EXACT_SOURCE_URL" target="_blank" rel="noopener">Outlet Name</a> — for example: \'according to <a href="https://example.com/x" target="_blank" rel="noopener">TechCrunch</a>\'. Use the EXACT url and outlet name given to you, never a placeholder or a guessed one. If two sources report the same fact, attribute it to whichever one you are quoting/paraphrasing at that point. Never state a specific fact without one of these links somewhere nearby in the same paragraph.',
  'CRITICAL distinction — official statement vs. unconfirmed report: if the ONLY source available is the subject\'s own press release/company announcement, and the story also involves something reported elsewhere as a rumor, plan, or unconfirmed development (e.g. "expected to IPO", "reportedly in talks"), you must NOT phrase that unconfirmed part as if the company itself confirmed it. Only state as confirmed fact what the primary source itself explicitly says. Anything attributed to reporting/rumor should be phrased with clear hedging ("according to a report by X", "X reported that..., though the company has not confirmed this") and attributed to whichever outlet actually reported it — never uncritically upgraded to a confirmed fact just because it appears near an official announcement.',
  '',
  'The "body" field must use this lightweight markup ONLY — do not use any other markdown syntax (no **bold**, no *italic*, no [text](url) markdown links — links MUST be real <a href="..."> HTML tags as described above, no numbered lists):',
  '- A blank line between two lines means a paragraph break.',
  '- A line starting with "## " is a subheading (use 3-5 of these to break up the article into clear sections — each one specific and useful, naming the actual person/product/event/angle that section covers, never a generic label; see the CRITICAL note above on formulaic subheadings).',
  '- Consecutive lines starting with "- " form a bullet list (use only if it genuinely fits the content). Bullet items are plain text, never bold.',
  '',
  'You will also be given the category the source feed is filed under, plus the full list of valid site categories. Some source feeds are broad (e.g. a general tech feed) and mis-file stories that actually belong elsewhere (e.g. a gaming or business story filed under "technology") — read the actual headline/summary and pick the single best-fitting "category" slug from the full list. If the feed\'s original category is genuinely the best fit, just confirm it.',
  '',
  'Also estimate "readTime" as "N min" based on the body length.',
  '',
  'List up to 5 of the article\'s main factual claims in "keyClaims" — each one a short plain-text sentence (no HTML) plus which source it came from. Use "sourceLabel" equal to the exact outlet name of whichever given source supports that claim, or "context" if the claim is general background/framing you added rather than something from a specific source. This is for an editor\'s quick-review checklist, so keep each claim to one concrete fact (a number, a date, a decision, a quote/attribution, a stated plan) — not a vague summary sentence.',
  '',
  'EDITORIAL VALUE (mandatory, VexlowHQ editorial policy 2026-09-24, strengthened 2026-09-27): the article body must, in its own natural prose (never as literal labeled Q&A headings unless a subheading genuinely fits that phrasing), actually answer: what happened, why it matters right now, what is confirmed vs. what remains uncertain, and what readers should watch next. Beyond the bare facts, when the sources genuinely support it, develop AT LEAST 4 of the editorial elements below — each one written out as real, substantive sentences or a real paragraph grounded in the given headline/summary/sources, never a bare subheading with nothing under it and never a single throwaway clause. Do not force an element that the sources cannot honestly support, do not invent context to manufacture one, and never pad the article with repetitive filler just to reach a count:',
  '- Previous/background context: what led up to this, or what the people/companies/technology involved are, using only general, safe-to-assert framing (e.g. "since its debut" / "the previous edition of this event") — never a new invented date, number, or name.',
  '- Timeline: if the sources describe a real sequence of events, trace it explicitly and in order, anchored to at least two concrete points — actual distinct dates, actual distinct times/moments, or an explicit ordered sequence ("first... then... later...") where each step names a real, specific development, not a vague "over time" or a bare sequencing word with nothing behind it.',
  '- Comparison to precedent: explicitly compare this to a past product, announcement, result, or event using direct comparison language ("compared to", "compared with", "unlike", "versus") — not just a passing mention.',
  '- Consequences: spell out concrete consequences for users, the industry, teams, or the audience using direct language ("this means for...", "as a result,", "this could affect...", "the implications for...").',
  '- Why it matters now: a real paragraph, not one sentence, on why this specific development is significant at this moment.',
  '- Attributed comparative data: a figure, date, or statistic that is explicitly attributed to one of the given sources and set against a prior figure or benchmark.',
  '- Confirmed vs. reported: this one requires an actual CONTRAST, not just one attributed fact — a lone attribution like "X announced..." or "officials confirmed..." does NOT by itself count, even though it is good, necessary attribution elsewhere in the article. In the SAME paragraph, state one thing that is officially confirmed AND another thing that is only reported, rumored, preliminary, or not yet confirmed, making the distinction explicit (e.g. "X confirmed that ..., while Y remains unconfirmed and was only reported by ..." or "X officially confirmed ...; however, it has not confirmed whether ..."). Only include this when the sources actually contain both a confirmed fact and an unconfirmed/reported one — never invent an uncertainty just to manufacture the contrast.',
  '- Limitations or open questions: name a real, specific thing that is still unclear, undisclosed, or unresolved as of this writing ("however,", "it remains unclear whether...", "X has not disclosed...") — not a generic "time will tell".',
  'Two additional elements exist as a bonus, only when they genuinely fit the story (never force them): a plain-language technical explanation of how something works, and US-specific availability/pricing/relevance.',
  'If the given headline/summary is too thin to honestly develop at least 3 of these elements without inventing anything or converting a rumor into a stated fact, do NOT force it or pad the article to look more complete than it is — write a shorter, plainly factual piece instead. It is expected and correct for such a piece to stay in human review rather than being dressed up as ready; a short, honest article is always better than a padded one.',
  'Then, separately from the body, self-report this in "editorialValueClaims" (this is a self-check for the editor, not something printed on the page): "whatHappened" (one sentence), "whyItMatters" (one sentence), "confirmed" (array of short strings, facts stated as officially confirmed), "uncertain" (array of short strings, facts still unconfirmed/disputed/unknown — empty array if genuinely nothing is uncertain), "whatToWatch" (array of short strings, concrete next developments to watch for), and "elementsUsed" (array of which of the editorial elements listed above you actually incorporated, using these exact keys: "historical-context", "timeline", "comparison", "consequences", "limitations", "confirmed-vs-reported", "technical-explanation", "us-availability", "what-to-watch", "comparative-list"). This self-report is a hint for the editor\'s checklist only — VexlowHQ independently re-checks the body for real evidence of each element and ignores this self-report entirely when deciding readiness, so never claim an element you did not actually develop in the body.',
  '',
  'Respond with ONLY a single JSON object, no markdown code fences, no commentary, with exactly these keys:',
  '{"title": "...", "dek": "...", "body": "...", "category": "...", "readTime": "...", "keyClaims": [{"claim": "...", "sourceLabel": "..."}], "editorialValueClaims": {"whatHappened": "...", "whyItMatters": "...", "confirmed": ["..."], "uncertain": ["..."], "whatToWatch": ["..."], "elementsUsed": ["..."]}}',
].join('\n');

function formatSourcesBlock(item, sources) {
  var primary = (sources && sources.primary) || { url: item.link, outlet: item.category };
  var additional = (sources && sources.additional) || [];
  var lines = ['Sources available (use these EXACT urls/names for attribution links):',
    '- PRIMARY: "' + (primary.outlet || 'source') + '" — ' + primary.url];
  additional.forEach(function (s) {
    if (!s || !s.url) return;
    lines.push('- ADDITIONAL (corroborating): "' + (s.outlet || 'source') + '" — ' + s.url);
  });
  if (!additional.length) {
    lines.push('(No additional corroborating source was found for this story — do not invent one. If the story touches on something unconfirmed/rumored, hedge it and attribute it to the primary source\'s own framing rather than presenting it as independently confirmed.)');
  }
  return lines.join('\n');
}

function draftArticle(item, cfg, categoryOptions, sources) {
  cfg = cfg || loadConfig();
  var provider = cfg.draftProvider || 'anthropic';
  var apiKey = provider === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!apiKey) {
    return Promise.reject(new Error('NO_API_KEY'));
  }
  var categoriesList = (categoryOptions || []).map(function (c) { return c.slug + ' — ' + c.label; }).join('\n');
  var userPrompt = [
    'Source headline: ' + item.title,
    'Source summary: ' + (item.summary || '(no summary provided)'),
    'Source link: ' + item.link,
    'Source feed\'s original category: ' + item.category,
    '',
    formatSourcesBlock(item, sources),
    '',
    'Valid site category slugs:',
    categoriesList || item.category,
  ].join('\n');

  var call = provider === 'openai'
    ? callOpenAI(apiKey, cfg.draftModel || 'gpt-4o-mini', SYSTEM_PROMPT, userPrompt)
    : callAnthropic(apiKey, cfg.draftModel || 'claude-sonnet-5', SYSTEM_PROMPT, userPrompt);

  return call.then(function (callResult) {
    var text = callResult.text;
    var aiCallMeta = callResult.meta;
    var result = extractJson(text);
    if (!result.title || !result.body) throw new Error('Borrador incompleto (falta title o body)');
    var validCategory = (categoryOptions || []).some(function (c) { return c.slug === result.category; });
    var category = validCategory ? result.category : item.category;
    // keyClaims es un agregado para la ficha de revisión rápida del panel
    // -- si el modelo no lo devolvió bien formado, se guarda vacío en vez
    // de romper todo el artículo (el resto del artículo sigue siendo
    // válido sin esto).
    var keyClaims = sanitizeKeyClaims(result.keyClaims);
    return {
      title: stripMarkdownEmphasis(String(result.title).trim()),
      dek: stripMarkdownEmphasis(String(result.dek || '').trim()),
      body: stripMarkdownEmphasis(String(result.body)),
      category: category,
      readTime: String(result.readTime || '').trim(),
      keyClaims: keyClaims,
      // Aporte editorial (política 2026-09-24): declaración de la propia IA,
      // saneada pero NUNCA usada tal cual para decidir nada -- admin/
      // pipeline.js:computeEditorialValue() vuelve a verificar cada elemento
      // contra el cuerpo real antes de contarlo. Ver sanitizeEditorialValueClaims.
      editorialValueClaims: sanitizeEditorialValueClaims(result.editorialValueClaims),
      // Metadata técnica de la llamada (pedido 2026-09-27, punto 6): nunca
      // el prompt ni la respuesta cruda, nunca una clave -- solo lo
      // necesario para que pipeline.js pueda distinguir un truncamiento
      // real de una decisión del modelo. admin/pagegen.js y
      // generate_pages.py NUNCA leen este campo -- no tiene ningún camino
      // hacia una página pública, ver test-writing-quality-validation.js.
      aiCallMeta: aiCallMeta
    };
  });
}

// Separado de draftArticle() por el mismo motivo que sanitizeKeyClaims: se
// puede probar sin simular una respuesta HTTPS real. Deliberadamente
// permisivo (nunca tira la redacción entera si esto viene mal formado) --
// el peor caso es que computeEditorialValue() en pipeline.js no tenga nada
// de qué completar whatHappened/whyItMatters/confirmed/uncertain/
// whatToWatch, lo cual solo implica más revisión manual, nunca un error.
function sanitizeEditorialValueClaims(raw) {
  if (!raw || typeof raw !== 'object') return {};
  function strArray(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(Boolean).slice(0, 10).map(function (x) { return String(x).trim(); }).filter(Boolean);
  }
  return {
    whatHappened: String(raw.whatHappened || '').trim(),
    whyItMatters: String(raw.whyItMatters || '').trim(),
    confirmed: strArray(raw.confirmed),
    uncertain: strArray(raw.uncertain),
    whatToWatch: strArray(raw.whatToWatch),
    elementsUsed: strArray(raw.elementsUsed)
  };
}

// Separado de draftArticle() para poder probarlo sin tener que simular una
// respuesta HTTPS real de Anthropic/OpenAI (ver test-source-provenance.js).
function sanitizeKeyClaims(rawKeyClaims) {
  if (!Array.isArray(rawKeyClaims)) return [];
  return rawKeyClaims
    .filter(function (c) { return c && c.claim; })
    .slice(0, 5)
    .map(function (c) {
      return { claim: stripMarkdownEmphasis(String(c.claim).trim()), sourceLabel: String(c.sourceLabel || 'context').trim() };
    });
}

// Red de seguridad por si el modelo se manda igual con **negrita**/*cursiva*
// del markdown genérico, que el parser del sitio no interpreta.
function stripMarkdownEmphasis(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
}

module.exports = {
  loadConfig: loadConfig,
  draftArticle: draftArticle,
  formatSourcesBlock: formatSourcesBlock,
  sanitizeKeyClaims: sanitizeKeyClaims,
  sanitizeEditorialValueClaims: sanitizeEditorialValueClaims
};
