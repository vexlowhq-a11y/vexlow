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
          resolve(text);
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
          var text = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
          resolve(text);
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
  'You will be given a headline, a short summary, and a source link from another outlet. Write an ORIGINAL article inspired by that story — never copy or closely paraphrase the source wording. Rewrite entirely in your own words and structure.',
  'Stay strictly factual: only use information present in the given headline/summary. Never invent quotes, statistics, dates, scores, venues, host cities/countries, or any other specific proper noun or number that was not explicitly provided — even ones that sound plausible or that you "know" from general knowledge, since the summary may be incomplete or about a fast-changing situation and a wrong specific detail is worse than a vaguer sentence. If you are not 100% certain a specific fact was in the source, phrase that sentence generically instead (e.g. "the host venue" instead of naming one) rather than guessing.',
  'This must read as a substantive, in-depth article, not a rewritten summary of the headline. Beyond the bare facts given, you are expected to add real editorial value: background/context on the people, companies or technology involved, how this fits into the broader trend or history of the topic, what similar past events or competing products looked like, what questions remain open, and what the likely implications are for readers, the industry, or the market. This context must stay at the level of general, safe-to-assert framing (e.g. widely-known history of a franchise or company) — never introduce a new specific fact (a date, a place, a number, a name) that is not in the given headline/summary.',
  'Tone: neutral, journalistic, engaging — matching a professional online news outlet. Aim for 600-900 words; do not pad with repetition or filler to hit the count — every paragraph should add a genuinely new angle, fact-adjacent context, or implication.',
  '',
  'The "body" field must use this lightweight markup ONLY — do not use any other markdown syntax (no **bold**, no *italic*, no [links](url), no numbered lists):',
  '- A blank line between two lines means a paragraph break.',
  '- A line starting with "## " is a subheading (use 2-4 of these to break up the article into clear sections).',
  '- Consecutive lines starting with "- " form a bullet list (use only if it genuinely fits the content). Bullet items are plain text, never bold.',
  '- Insert a line that is EXACTLY "[publicidad]" once, roughly in the middle of the article, as an ad-slot marker.',
  '',
  'Also pick the single best-fitting "topic" slug from the provided list for this category (or "" if none fit well), and estimate "readTime" as "N min" based on the body length.',
  '',
  'Respond with ONLY a single JSON object, no markdown code fences, no commentary, with exactly these keys:',
  '{"title": "...", "dek": "...", "body": "...", "topic": "...", "readTime": "..."}',
].join('\n');

function draftArticle(item, topicOptions, cfg) {
  cfg = cfg || loadConfig();
  var provider = cfg.draftProvider || 'anthropic';
  var apiKey = provider === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!apiKey) {
    return Promise.reject(new Error('NO_API_KEY'));
  }
  var topicsList = (topicOptions || []).map(function (t) { return t.slug + ' — ' + t.label; }).join('\n');
  var userPrompt = [
    'Source headline: ' + item.title,
    'Source summary: ' + (item.summary || '(no summary provided)'),
    'Source link: ' + item.link,
    '',
    'Available topic slugs for this category:',
    topicsList || '(none — use "")',
  ].join('\n');

  var call = provider === 'openai'
    ? callOpenAI(apiKey, cfg.draftModel || 'gpt-4o-mini', SYSTEM_PROMPT, userPrompt)
    : callAnthropic(apiKey, cfg.draftModel || 'claude-sonnet-5', SYSTEM_PROMPT, userPrompt);

  return call.then(function (text) {
    var result = extractJson(text);
    if (!result.title || !result.body) throw new Error('Borrador incompleto (falta title o body)');
    var validTopic = (topicOptions || []).some(function (t) { return t.slug === result.topic; });
    return {
      title: stripMarkdownEmphasis(String(result.title).trim()),
      dek: stripMarkdownEmphasis(String(result.dek || '').trim()),
      body: stripMarkdownEmphasis(String(result.body)),
      topic: validTopic ? result.topic : '',
      readTime: String(result.readTime || '').trim()
    };
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
  draftArticle: draftArticle
};
