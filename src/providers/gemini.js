// src/providers/gemini.js
// Provider Google Gemini (Generative Language API)
// Expose globalThis.autoGymglishGemini avec id/label/defaultModel/suggestedModels/complete

(function (global) {
  'use strict';

  const id = 'gemini';
  const label = 'Google Gemini';

  // Modèles vérifiés via WebSearch (mai 2026) :
  // - gemini-3-pro-preview / gemini-3.1-pro-preview : reasoning-first, agentic
  // - gemini-3.1-flash-lite-preview : low-latency, cost-efficient
  // - gemini-2.5-flash et gemini-2.5-pro : encore disponibles (2.5 maintenu, 2.0 shutdown 2026-06-01)
  const defaultModel = 'gemini-2.5-flash';
  const suggestedModels = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
  ];

  const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const DEFAULT_TIMEOUT_MS = 60_000;

  // ---------- Conversion JSON Schema -> sous-ensemble Gemini ----------

  const TYPE_MAP = {
    string: 'STRING',
    number: 'NUMBER',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
  };

  // Keywords retirés systématiquement
  const STRIPPED_KEYS = new Set([
    '$schema',
    '$id',
    '$ref',
    '$defs',
    'definitions',
    'unevaluatedProperties',
    'patternProperties',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    'const',
    'examples',
    'default',
    'title',
    'additionalProperties',
  ]);

  function normalizeType(t) {
    if (!t) return undefined;
    if (Array.isArray(t)) {
      // Type union — Gemini ne gère pas, on prend le premier non-"null"
      const primary = t.find((x) => x && x !== 'null') || t[0];
      return normalizeType(primary);
    }
    const lower = String(t).toLowerCase();
    return TYPE_MAP[lower] || String(t).toUpperCase();
  }

  function convertSchemaToGemini(jsonSchema) {
    if (jsonSchema === null || jsonSchema === undefined) return jsonSchema;
    if (typeof jsonSchema !== 'object') return jsonSchema;
    if (Array.isArray(jsonSchema)) return jsonSchema.map(convertSchemaToGemini);

    // Cas spécial : objet avec additionalProperties mais sans properties statiques
    // → Gemini ne peut pas représenter ça. On le remplace par un STRING (JSON
    // sérialisé), parsé côté client. Le prompt système décrit déjà la structure.
    if (
      jsonSchema.type === 'object' &&
      jsonSchema.additionalProperties &&
      !jsonSchema.properties
    ) {
      return {
        type: 'STRING',
        description:
          'JSON object as string. Keys are the ids from the exercise (e.g. BRAF... or BRAM...), values are the chosen ids/strings. Example: {"BRAF31214":"BRAC106048"}',
      };
    }

    const out = {};
    for (const [key, value] of Object.entries(jsonSchema)) {
      if (STRIPPED_KEYS.has(key)) continue;

      if (key === 'type') {
        out.type = normalizeType(value);
        continue;
      }

      if (key === 'properties' && value && typeof value === 'object') {
        const props = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          props[propName] = convertSchemaToGemini(propSchema);
        }
        out.properties = props;
        continue;
      }

      if (key === 'items') {
        out.items = convertSchemaToGemini(value);
        continue;
      }

      if (key === 'required' && Array.isArray(value)) {
        out.required = value.slice();
        continue;
      }

      if (key === 'enum' && Array.isArray(value)) {
        out.enum = value.map((v) => (typeof v === 'string' ? v : String(v)));
        continue;
      }

      if (key === 'description' || key === 'nullable' || key === 'format') {
        out[key] = value;
        continue;
      }

      // Clés inconnues : on les ignore par sécurité (Gemini est strict)
    }
    return out;
  }

  // ---------- Construction body ----------

  function buildRequestBody({ systemPrompt, userPrompt, schema, temperature, audioParts }) {
    const parts = [];
    const audio = Array.isArray(audioParts) ? audioParts : [];
    for (const a of audio) {
      if (!a || !a.base64) continue;
      parts.push({
        inline_data: {
          mime_type: a.mimeType || 'audio/mp3',
          data: a.base64,
        },
      });
    }
    parts.push({ text: String(userPrompt ?? '') });

    const body = {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : 0.0,
      },
    };

    if (systemPrompt && String(systemPrompt).trim().length > 0) {
      body.systemInstruction = {
        parts: [{ text: String(systemPrompt) }],
      };
    }

    if (schema) {
      body.generationConfig.responseMimeType = 'application/json';
      // Gemini accepte un schema mais pas additionalProperties.
      // Astuce : on convertit les objets à clés dynamiques (dropdowns/blanks)
      // en simple type:OBJECT sans properties — Gemini accepte alors n'importe quel objet.
      body.generationConfig.responseSchema = convertSchemaToGemini(schema);
    }

    return body;
  }

  // ---------- Erreurs ----------

  function extractApiErrorMessage(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (payload.error && typeof payload.error === 'object') {
      const e = payload.error;
      const parts = [];
      if (e.status) parts.push(e.status);
      if (e.message) parts.push(e.message);
      return parts.join(' — ');
    }
    try {
      return JSON.stringify(payload).slice(0, 500);
    } catch {
      return '';
    }
  }

  function buildHttpError(status, payload) {
    const detail = extractApiErrorMessage(payload);
    if (status === 400) {
      return new Error(
        `Gemini: requete invalide — verifie la cle API ou le schema. Detail: ${detail}`
      );
    }
    if (status === 401 || status === 403) {
      return new Error(`Gemini: cle API invalide ou non autorisee (HTTP ${status}). Detail: ${detail}`);
    }
    if (status === 404) {
      return new Error(`Gemini: modele introuvable (HTTP 404). Detail: ${detail}`);
    }
    if (status === 429) {
      return new Error(`Gemini: quota depasse (HTTP 429). Detail: ${detail}`);
    }
    if (status >= 500) {
      return new Error(`Gemini indisponible (HTTP ${status}). Detail: ${detail}`);
    }
    return new Error(`Gemini: erreur HTTP ${status}. Detail: ${detail}`);
  }

  // ---------- Appel principal ----------

  async function complete({ systemPrompt, userPrompt, schema, settings, audioParts } = {}) {
    const cfg = settings || {};
    const apiKey = cfg.apiKey;
    const model = cfg.model || defaultModel;
    const temperature = cfg.temperature;
    const timeoutMs =
      typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Gemini: cle API manquante (settings.apiKey)');
    }
    if (!model || typeof model !== 'string') {
      throw new Error('Gemini: nom de modele manquant (settings.model)');
    }

    const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = buildRequestBody({ systemPrompt, userPrompt, schema, temperature, audioParts });

    const audioCount = Array.isArray(audioParts) ? audioParts.length : 0;
    console.debug(`[autoGymglish/gemini] request to model ${model}` + (audioCount > 0 ? ` with ${audioCount} audio part(s)` : ''));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error(`Gemini: timeout apres ${timeoutMs} ms`);
      }
      throw new Error(`Gemini: echec reseau — ${err && err.message ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        try {
          payload = await response.text();
        } catch {
          payload = '';
        }
      }
      throw buildHttpError(response.status, payload);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(
        `Gemini: reponse non JSON — ${err && err.message ? err.message : String(err)}`
      );
    }

    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : null;
    const text = parts && parts[0] && typeof parts[0].text === 'string' ? parts[0].text : null;

    if (!text) {
      const finishReason = candidate && candidate.finishReason ? candidate.finishReason : 'inconnu';
      throw new Error(
        `Gemini: reponse vide ou format inattendu (finishReason=${finishReason})`
      );
    }

    // Post-traitement : dropdowns/blanks ont été demandés en STRING (JSON sérialisé)
    // car Gemini ne supporte pas additionalProperties. On les re-parse en objets.
    return rehydrateDynamicObjects(text);
  }

  function rehydrateDynamicObjects(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return rawText; // laisse le parser tolérant de base.js gérer
    }
    const answers = parsed && Array.isArray(parsed.answers) ? parsed.answers : null;
    if (!answers) return JSON.stringify(parsed);
    for (const ans of answers) {
      for (const key of ['dropdowns', 'blanks']) {
        if (typeof ans[key] === 'string') {
          try {
            ans[key] = JSON.parse(ans[key]);
          } catch {
            // garde la string si ça merde — la validation remontera l'erreur
          }
        }
      }
    }
    return JSON.stringify(parsed);
  }

  // ---------- Export ----------

  const exportsObj = {
    id,
    label,
    defaultModel,
    suggestedModels,
    complete,
    // expose pour tests internes éventuels
    _convertSchemaToGemini: convertSchemaToGemini,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
  }
  global.autoGymglishGemini = exportsObj;
})(typeof globalThis !== 'undefined' ? globalThis : this);
