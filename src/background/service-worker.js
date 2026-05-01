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

async function handleSolve(payload) {
  if (!payload || !Array.isArray(payload.exercises)) {
    throw new Error("Payload invalide : exercises[] manquant");
  }
  const settings = await getSettings();
  const providerId = settings.provider;
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Provider inconnu : ${providerId}`);

  const userPrompt = base.buildUserPrompt(payload);
  const providerSettings = settings[providerId] || {};

  console.debug("[autoGymglish/sw] solving via", providerId, "with", payload.exercises.length, "exercises");

  const rawText = await provider.complete({
    systemPrompt: base.SYSTEM_PROMPT,
    userPrompt,
    schema: base.RESPONSE_SCHEMA,
    settings: providerSettings
  });

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
