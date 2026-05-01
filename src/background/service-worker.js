"use strict";

// MV3 classic service worker — importScripts est dispo (vs ESM module worker).
importScripts(
  "/src/providers/base.js",
  "/src/providers/gemini.js",
  "/src/providers/claude.js",
  "/src/providers/ollama.js"
);

const PROVIDERS = {
  gemini: globalThis.autoGymglishGemini,
  claude: globalThis.autoGymglishClaude,
  ollama: globalThis.autoGymglishOllama
};

const base = globalThis.autoGymglishBase;

const DEFAULT_SETTINGS = {
  provider: "gemini",
  gemini: { apiKey: "", model: globalThis.autoGymglishGemini?.defaultModel || "" },
  claude: { apiKey: "", model: globalThis.autoGymglishClaude?.defaultModel || "" },
  ollama: {
    baseUrl: globalThis.autoGymglishOllama?.defaultBaseUrl || "http://localhost:11434",
    model: globalThis.autoGymglishOllama?.defaultModel || ""
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[autoGymglish] service worker ready");
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function mimeTypeFromUrl(url) {
  if (typeof url !== "string") return "audio/mp3";
  const clean = url.split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".mp3")) return "audio/mp3";
  if (clean.endsWith(".ogg") || clean.endsWith(".oga")) return "audio/ogg";
  if (clean.endsWith(".wav")) return "audio/wav";
  if (clean.endsWith(".m4a") || clean.endsWith(".mp4")) return "audio/mp4";
  if (clean.endsWith(".webm")) return "audio/webm";
  if (clean.endsWith(".aac")) return "audio/aac";
  if (clean.endsWith(".flac")) return "audio/flac";
  return "audio/mp3";
}

async function fetchAudioAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`audio fetch ${resp.status}: ${url}`);
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > 10 * 1024 * 1024) {
    throw new Error(`audio too large (${buf.byteLength} bytes): ${url}`);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchAudioParts(dictations) {
  const out = [];
  const skipped = [];
  for (const d of dictations) {
    if (!d || !d.audioUrl) {
      skipped.push({ id: d && d.id, reason: "audio-missing" });
      continue;
    }
    try {
      const base64 = await fetchAudioAsBase64(d.audioUrl);
      out.push({
        exerciseId: d.id,
        mimeType: mimeTypeFromUrl(d.audioUrl),
        base64
      });
    } catch (err) {
      console.warn("[autoGymglish/sw] audio fetch failed for", d.id, err && err.message ? err.message : err);
      skipped.push({ id: d.id, reason: "audio-fetch-failed" });
    }
  }
  return { audioParts: out, skipped };
}

async function callProvider(providerId, payload, providerSettings, audioParts) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Provider inconnu : ${providerId}`);

  const userPrompt = base.buildUserPrompt(payload);
  const audioCount = Array.isArray(audioParts) ? audioParts.length : 0;
  console.debug(
    "[autoGymglish/sw] solving via", providerId,
    "with", payload.exercises.length, "exercises",
    audioCount > 0 ? `(+${audioCount} audio)` : ""
  );

  const completeArgs = {
    systemPrompt: base.SYSTEM_PROMPT,
    userPrompt,
    schema: base.RESPONSE_SCHEMA,
    settings: providerSettings
  };
  if (audioCount > 0) completeArgs.audioParts = audioParts;

  const rawText = await provider.complete(completeArgs);

  let parsed;
  try {
    parsed = base.parseLLMResponse(rawText);
  } catch (e) {
    console.warn("[autoGymglish/sw] parseLLMResponse failed, raw:", rawText);
    throw new Error("Le LLM n'a pas renvoyé du JSON valide : " + e.message);
  }

  const validation = base.validateAnswers(parsed.answers || [], payload);
  return {
    answers: parsed.answers || [],
    validation,
    provider: providerId,
    model: providerSettings.model
  };
}

async function handleSolve(payload) {
  if (!payload || !Array.isArray(payload.exercises)) {
    throw new Error("Payload invalide : exercises[] manquant");
  }
  const settings = await getSettings();
  const providerId = settings.provider;
  if (!PROVIDERS[providerId]) throw new Error(`Provider inconnu : ${providerId}`);

  const dictations = payload.exercises.filter((e) => e && e.type === "text-dictation");
  const audioSkipped = [];

  if (dictations.length === 0) {
    const providerSettings = settings[providerId] || {};
    return await callProvider(providerId, payload, providerSettings);
  }

  const hasGeminiKey = !!(settings.gemini && settings.gemini.apiKey);

  if (!hasGeminiKey) {
    const filteredExercises = payload.exercises.filter((e) => !e || e.type !== "text-dictation");
    for (const d of dictations) audioSkipped.push({ id: d.id, reason: "audio-no-gemini" });
    const newPayload = { ...payload, exercises: filteredExercises };
    const providerSettings = settings[providerId] || {};
    if (filteredExercises.length === 0) {
      console.debug("[autoGymglish/sw] only dictations, no Gemini key — nothing to solve");
      return {
        answers: [],
        validation: { ok: true, errors: [] },
        provider: providerId,
        model: providerSettings.model,
        skipped: audioSkipped
      };
    }
    const result = await callProvider(providerId, newPayload, providerSettings);
    result.skipped = [...(result.skipped || []), ...audioSkipped];
    return result;
  }

  const { audioParts, skipped } = await fetchAudioParts(dictations);
  audioSkipped.push(...skipped);

  const validDictationIds = new Set(audioParts.map((p) => p.exerciseId));
  const filteredExercises = payload.exercises.filter(
    (e) => !e || e.type !== "text-dictation" || validDictationIds.has(e.id)
  );

  const orderedDictationIds = filteredExercises
    .filter((e) => e && e.type === "text-dictation")
    .map((e) => e.id);
  const partsByExerciseId = new Map(audioParts.map((p) => [p.exerciseId, p]));
  const orderedAudioParts = orderedDictationIds
    .map((id) => partsByExerciseId.get(id))
    .filter(Boolean)
    .map(({ mimeType, base64 }) => ({ mimeType, base64 }));

  const newPayload = { ...payload, exercises: filteredExercises };
  const geminiSettings = settings.gemini || {};

  if (filteredExercises.length === 0) {
    console.debug("[autoGymglish/sw] all dictations failed audio fetch — nothing to solve");
    return {
      answers: [],
      validation: { ok: true, errors: [] },
      provider: "gemini",
      model: geminiSettings.model,
      skipped: audioSkipped
    };
  }

  const result = await callProvider("gemini", newPayload, geminiSettings, orderedAudioParts);
  result.skipped = [...(result.skipped || []), ...audioSkipped];
  return result;
}

async function handleListOllamaModels(baseUrl) {
  if (!PROVIDERS.ollama || !PROVIDERS.ollama.listInstalledModels) {
    throw new Error("Provider Ollama indisponible");
  }
  return await PROVIDERS.ollama.listInstalledModels(baseUrl);
}

const HANDLERS = {
  SOLVE: (msg) => handleSolve(msg.payload),
  LIST_OLLAMA_MODELS: (msg) => handleListOllamaModels(msg.baseUrl),
  GET_PROVIDERS: () => ({
    providers: Object.values(PROVIDERS)
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        label: p.label,
        defaultModel: p.defaultModel,
        defaultBaseUrl: p.defaultBaseUrl,
        suggestedModels: p.suggestedModels || []
      }))
  })
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      console.error("[autoGymglish/sw] handler error:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
  return true;
});
