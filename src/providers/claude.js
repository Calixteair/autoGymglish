// Provider Anthropic Claude pour autoGymglish
// Expose globalThis.autoGymglishClaude (compatible service worker MV3 et Node).
// Doc API : https://docs.anthropic.com/en/api/messages

(function (global) {
  'use strict';

  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_VERSION = '2023-06-01';
  const DEFAULT_TIMEOUT_MS = 60000;
  const DEFAULT_MAX_TOKENS = 4096;

  const id = 'claude';
  const label = 'Anthropic Claude';
  const defaultModel = 'claude-haiku-4-5-20251001';
  const suggestedModels = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7'
  ];

  /**
   * Construit le body de la requête Messages API.
   * Si schema est fourni, on bascule en "tool use forcing" pour garantir un JSON
   * structuré dans response.content[0].input — plus robuste qu'un "respond with JSON"
   * en prompt, qui peut générer du texte parasite (markdown fences, prose).
   */
  function modelSupportsTemperature(model) {
    if (typeof model !== 'string') return true;
    const m = model.toLowerCase();
    if (m.includes('opus-4')) return false;
    if (m.includes('sonnet-4-5') || m.includes('sonnet-4-6')) return false;
    return true;
  }

  function buildBody({ systemPrompt, userPrompt, schema, model, temperature }) {
    const body = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: userPrompt }]
    };

    if (modelSupportsTemperature(model)) {
      body.temperature = typeof temperature === 'number' ? temperature : 0.0;
    }

    if (systemPrompt && typeof systemPrompt === 'string') {
      body.system = systemPrompt;
    }

    if (schema && typeof schema === 'object') {
      if (schema.type !== 'object') {
        throw new Error('[claude] schema must be a JSON Schema with top-level type "object"');
      }
      body.tools = [
        {
          name: 'answer',
          description: 'Submit the answers to the exercises',
          input_schema: schema
        }
      ];
      body.tool_choice = { type: 'tool', name: 'answer' };
    }

    return body;
  }

  /**
   * Extrait un message d'erreur lisible depuis une réponse HTTP non-OK.
   */
  async function extractApiError(response) {
    let detail = '';
    try {
      const data = await response.json();
      if (data && data.error && data.error.message) {
        detail = data.error.message;
      } else {
        detail = JSON.stringify(data);
      }
    } catch (_e) {
      try {
        detail = await response.text();
      } catch (_e2) {
        detail = '';
      }
    }
    const status = response.status;
    if (status === 401) return `Clé API invalide (401)${detail ? ' : ' + detail : ''}`;
    if (status === 400) return `Requête invalide (400)${detail ? ' : ' + detail : ''}`;
    if (status === 429) return `Quota dépassé / rate limit (429)${detail ? ' : ' + detail : ''}`;
    if (status >= 500) return `Service Claude indisponible (${status})${detail ? ' : ' + detail : ''}`;
    return `Erreur Claude HTTP ${status}${detail ? ' : ' + detail : ''}`;
  }

  /**
   * Extrait le rawText depuis le payload Claude.
   * - Avec schema : on cible le tool_use "answer" et on stringifie son input.
   * - Sinon : on concatène les blocs de texte.
   */
  function extractRawText(data, hasSchema) {
    const blocks = Array.isArray(data && data.content) ? data.content : [];

    if (hasSchema) {
      const toolBlock = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'answer');
      if (!toolBlock || typeof toolBlock.input === 'undefined') {
        throw new Error('[claude] tool_use "answer" absent de la réponse');
      }
      return JSON.stringify(toolBlock.input);
    }

    const textParts = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    if (textParts.length === 0) {
      throw new Error('[claude] aucun bloc texte dans la réponse');
    }
    return textParts.join('');
  }

  /**
   * Appel principal : envoie la requête et retourne le rawText.
   */
  async function complete({ systemPrompt, userPrompt, schema, settings } = {}) {
    if (!settings || typeof settings !== 'object') {
      throw new Error('[claude] settings manquant');
    }
    const apiKey = settings.apiKey;
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('[claude] apiKey manquante dans settings');
    }
    if (!userPrompt || typeof userPrompt !== 'string') {
      throw new Error('[claude] userPrompt requis');
    }

    const model = settings.model || defaultModel;
    const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0
      ? settings.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    const body = buildBody({
      systemPrompt,
      userPrompt,
      schema,
      model,
      temperature: settings.temperature
    });

    console.debug(`[autoGymglish/claude] request to model ${model}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error(`[claude] timeout après ${timeoutMs}ms`);
      }
      throw new Error(`[claude] échec réseau : ${err && err.message ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const message = await extractApiError(response);
      throw new Error(`[claude] ${message}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(`[claude] réponse JSON invalide : ${err && err.message ? err.message : String(err)}`);
    }

    return extractRawText(data, Boolean(schema));
  }

  const exports = { id, label, defaultModel, suggestedModels, complete };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
  global.autoGymglishClaude = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this);
