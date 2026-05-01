/**
 * autoGymglish — providers/ollama.js
 *
 * Provider Ollama (instance locale ou distante non authentifiée).
 * Expose globalThis.autoGymglishOllama avec la même forme que les autres providers :
 *   - id, label, defaultBaseUrl, defaultModel, suggestedModels
 *   - listInstalledModels(baseUrl) → string[] (noms des modèles installés)
 *   - complete({ systemPrompt, userPrompt, schema, settings }) → string (rawText)
 *
 * Détails :
 *   - Endpoint chat : POST {baseUrl}/api/chat (stream:false)
 *   - Sortie structurée : "format": <jsonSchema> si fourni, sinon "format": "json"
 *   - Auto /no_think pour Qwen3 (contournement bug structured output)
 *   - Pas de header d'auth (Ollama local par défaut)
 */
(function (global) {
  'use strict';

  var ID = 'ollama';
  var LABEL = 'Ollama (local)';
  var DEFAULT_BASE_URL = 'http://localhost:11434';
  var DEFAULT_MODEL = 'qwen3:8b';
  var DEFAULT_TIMEOUT_MS = 1800000;

  // Liste indicative — sert juste à pré-remplir l'UI quand l'instance est down.
  var SUGGESTED_MODELS = [
    'qwen3:32b',
    'qwen3:8b',
    'llama3.1:8b',
    'llama3.1:70b',
    'mistral:7b',
    'gemma2:9b'
  ];

  function trimTrailingSlash(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    return s.charAt(s.length - 1) === '/' ? s.slice(0, -1) : s;
  }

  function isQwen3(model) {
    return typeof model === 'string' && model.toLowerCase().indexOf('qwen3') === 0;
  }

  function buildUserPromptWithNoThink(userPrompt, model, disableNoThink) {
    if (disableNoThink) return userPrompt;
    if (!isQwen3(model)) return userPrompt;
    var p = (typeof userPrompt === 'string') ? userPrompt : '';
    if (/\/no_think\s*$/i.test(p)) return p;
    return (p.length > 0 ? p + '\n\n' : '') + '/no_think';
  }

  function buildBody(systemPrompt, userPromptFinal, schema, model, temperature) {
    var body = {
      model: model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: userPromptFinal }
      ],
      options: {
        temperature: typeof temperature === 'number' ? temperature : 0.0
      }
    };
    if (schema && typeof schema === 'object') {
      body.format = schema;
    } else {
      body.format = 'json';
    }
    return body;
  }

  function describeNetworkError(baseUrl, err) {
    var msg = (err && err.message) ? err.message : String(err);
    return new Error(
      'Ollama injoignable sur ' + baseUrl + ' (' + msg + '). ' +
      'Ollama est-il lancé ? Vérifie : `ollama serve`'
    );
  }

  async function readErrorBody(res) {
    var text = '';
    try {
      text = await res.text();
    } catch (_) {
      return '';
    }
    if (!text) return '';
    try {
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string') return parsed.error;
    } catch (_) {}
    return text.length > 500 ? text.slice(0, 500) + '…' : text;
  }

  async function listInstalledModels(baseUrl) {
    var url = trimTrailingSlash(baseUrl || DEFAULT_BASE_URL) + '/api/tags';
    var res;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (err) {
      throw describeNetworkError(baseUrl, err);
    }
    if (!res.ok) {
      var bodyMsg = await readErrorBody(res);
      throw new Error('Ollama /api/tags HTTP ' + res.status + (bodyMsg ? ' : ' + bodyMsg : ''));
    }
    var data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error('Ollama /api/tags: réponse JSON invalide (' + err.message + ')');
    }
    var models = (data && Array.isArray(data.models)) ? data.models : [];
    return models
      .map(function (m) { return m && typeof m.name === 'string' ? m.name : null; })
      .filter(function (n) { return n !== null; });
  }

  async function complete(args) {
    var opts = args || {};
    var settings = opts.settings || {};
    var baseUrl = trimTrailingSlash(settings.baseUrl || DEFAULT_BASE_URL);
    var model = settings.model || DEFAULT_MODEL;
    var timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
    var temperature = typeof settings.temperature === 'number' ? settings.temperature : 0.0;

    var userPromptFinal = buildUserPromptWithNoThink(
      opts.userPrompt,
      model,
      settings.disableNoThink === true
    );

    var body = buildBody(opts.systemPrompt, userPromptFinal, opts.schema, model, temperature);
    var url = baseUrl + '/api/chat';

    console.debug('[autoGymglish/ollama] request to ' + model + ' on ' + baseUrl);

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error('Ollama: timeout après ' + timeoutMs + 'ms (modèle ' + model + ')');
      }
      throw describeNetworkError(baseUrl, err);
    }
    clearTimeout(timer);

    if (res.status === 404) {
      var b404 = await readErrorBody(res);
      throw new Error(
        'Ollama: 404 sur ' + url + ' — URL incorrecte ou endpoint /api/chat absent' +
        (b404 ? ' (' + b404 + ')' : '')
      );
    }
    if (!res.ok) {
      var bodyMsg = await readErrorBody(res);
      throw new Error('Ollama HTTP ' + res.status + (bodyMsg ? ' : ' + bodyMsg : ''));
    }

    var data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error('Ollama: réponse JSON invalide (' + err.message + ')');
    }

    var content = (data && data.message && typeof data.message.content === 'string')
      ? data.message.content
      : '';
    if (!content || content.trim() === '') {
      throw new Error("Ollama: réponse vide, le modèle n'a peut-être pas pu charger");
    }
    return content;
  }

  var api = {
    id: ID,
    label: LABEL,
    defaultBaseUrl: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    suggestedModels: SUGGESTED_MODELS,
    listInstalledModels: listInstalledModels,
    complete: complete
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.autoGymglishOllama = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
