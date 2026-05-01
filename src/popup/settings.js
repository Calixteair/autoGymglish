"use strict";

const CUSTOM_VALUE = "__custom__";
const PROVIDER_IDS = ["gemini", "claude", "ollama"];

const els = {
  activeProvider: document.getElementById("active-provider"),
  geminiKey: document.getElementById("gemini-key"),
  geminiModel: document.getElementById("gemini-model"),
  geminiModelCustom: document.getElementById("gemini-model-custom"),
  claudeKey: document.getElementById("claude-key"),
  claudeModel: document.getElementById("claude-model"),
  claudeModelCustom: document.getElementById("claude-model-custom"),
  ollamaUrl: document.getElementById("ollama-url"),
  ollamaModel: document.getElementById("ollama-model"),
  ollamaModelCustom: document.getElementById("ollama-model-custom"),
  ollamaRefresh: document.getElementById("ollama-refresh"),
  ollamaStatus: document.getElementById("ollama-status"),
  save: document.getElementById("save"),
  saveStatus: document.getElementById("save-status")
};

const providerInfo = {};

function appendOption(selectEl, value, label) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  selectEl.appendChild(opt);
  return opt;
}

function fillModelSelect(selectEl, suggestedModels) {
  selectEl.replaceChildren();
  for (const m of suggestedModels) {
    appendOption(selectEl, m, m);
  }
  appendOption(selectEl, CUSTOM_VALUE, "(custom)");
}

function selectModel(selectEl, customInput, value, suggestedModels) {
  if (typeof value !== "string" || value === "") {
    if (selectEl.options.length > 0) selectEl.selectedIndex = 0;
    customInput.value = "";
    return;
  }
  if (suggestedModels.includes(value)) {
    selectEl.value = value;
    customInput.value = "";
  } else {
    selectEl.value = CUSTOM_VALUE;
    customInput.value = value;
  }
}

function readModel(selectEl, customInput) {
  if (selectEl.value === CUSTOM_VALUE) {
    return customInput.value.trim();
  }
  const custom = customInput.value.trim();
  if (custom) return custom;
  return selectEl.value;
}

async function fetchProviders() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_PROVIDERS" });
  if (!resp || resp.ok !== true) {
    throw new Error((resp && resp.error) || "GET_PROVIDERS failed");
  }
  return (resp.result && resp.result.providers) || [];
}

function buildProviderInfo(providers) {
  for (const p of providers) {
    if (!p || !p.id) continue;
    providerInfo[p.id] = {
      label: p.label || p.id,
      defaultModel: p.defaultModel || "",
      defaultBaseUrl: p.defaultBaseUrl || "",
      suggestedModels: Array.isArray(p.suggestedModels) ? p.suggestedModels.slice() : []
    };
  }
}

function fillActiveProviderSelect(currentId) {
  els.activeProvider.replaceChildren();
  for (const id of PROVIDER_IDS) {
    const info = providerInfo[id];
    if (!info) continue;
    const opt = appendOption(els.activeProvider, id, info.label);
    if (id === currentId) opt.selected = true;
  }
  refreshActiveCard(currentId);
}

function refreshActiveCard(activeId) {
  for (const id of PROVIDER_IDS) {
    const card = document.querySelector(`section.card[data-provider="${id}"]`);
    if (card) card.classList.toggle("is-active", id === activeId);
  }
}

function applySettingsToForm(settings) {
  fillActiveProviderSelect(settings.provider || "gemini");

  const gemSugg = providerInfo.gemini ? providerInfo.gemini.suggestedModels : [];
  const claSugg = providerInfo.claude ? providerInfo.claude.suggestedModels : [];
  const ollSugg = providerInfo.ollama ? providerInfo.ollama.suggestedModels : [];

  fillModelSelect(els.geminiModel, gemSugg);
  fillModelSelect(els.claudeModel, claSugg);
  fillOllamaModelSelect(ollSugg, []);

  const gem = settings.gemini || {};
  els.geminiKey.value = gem.apiKey || "";
  selectModel(els.geminiModel, els.geminiModelCustom, gem.model || (providerInfo.gemini?.defaultModel || ""), gemSugg);

  const cla = settings.claude || {};
  els.claudeKey.value = cla.apiKey || "";
  selectModel(els.claudeModel, els.claudeModelCustom, cla.model || (providerInfo.claude?.defaultModel || ""), claSugg);

  const oll = settings.ollama || {};
  els.ollamaUrl.value = oll.baseUrl || (providerInfo.ollama?.defaultBaseUrl || "");
  selectModel(els.ollamaModel, els.ollamaModelCustom, oll.model || (providerInfo.ollama?.defaultModel || ""), ollSugg);

  refreshAudioHint();
}

function refreshAudioHint() {
  const hasGeminiKey = !!(els.geminiKey.value.trim());
  const hints = document.querySelectorAll("[data-audio-hint]");
  hints.forEach((h) => {
    const status = h.querySelector("[data-audio-status]");
    if (!status) return;
    if (hasGeminiKey) {
      status.textContent = "enabled (Gemini key detected)";
      status.style.color = "var(--ok, #2d6a4f)";
    } else {
      status.textContent = "disabled (configure a Gemini key above)";
      status.style.color = "var(--ink-soft, #7a7a76)";
    }
  });
}

function fillOllamaModelSelect(suggestedModels, installedModels) {
  els.ollamaModel.replaceChildren();
  if (Array.isArray(installedModels) && installedModels.length > 0) {
    const groupInst = document.createElement("optgroup");
    groupInst.label = "Installed";
    for (const m of installedModels) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      groupInst.appendChild(opt);
    }
    els.ollamaModel.appendChild(groupInst);
  }
  if (Array.isArray(suggestedModels) && suggestedModels.length > 0) {
    const groupSugg = document.createElement("optgroup");
    groupSugg.label = "Suggested";
    for (const m of suggestedModels) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      groupSugg.appendChild(opt);
    }
    els.ollamaModel.appendChild(groupSugg);
  }
  appendOption(els.ollamaModel, CUSTOM_VALUE, "(custom)");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return stored.settings || {};
}

async function init() {
  try {
    const providers = await fetchProviders();
    buildProviderInfo(providers);
    const settings = await loadSettings();
    applySettingsToForm(settings);
  } catch (err) {
    console.warn("[autoGymglish/settings] init failed:", err);
    setSaveStatus("Erreur init : " + (err.message || String(err)), true);
  }
}

function setSaveStatus(text, isError) {
  els.saveStatus.textContent = text || "";
  els.saveStatus.classList.toggle("error", Boolean(isError));
}

function setOllamaStatus(text, kind) {
  els.ollamaStatus.textContent = text || "";
  els.ollamaStatus.classList.remove("success", "error");
  if (kind === "success") els.ollamaStatus.classList.add("success");
  if (kind === "error") els.ollamaStatus.classList.add("error");
}

async function handleSave() {
  const settings = {
    provider: els.activeProvider.value,
    gemini: {
      apiKey: els.geminiKey.value.trim(),
      model: readModel(els.geminiModel, els.geminiModelCustom)
    },
    claude: {
      apiKey: els.claudeKey.value.trim(),
      model: readModel(els.claudeModel, els.claudeModelCustom)
    },
    ollama: {
      baseUrl: els.ollamaUrl.value.trim() || (providerInfo.ollama?.defaultBaseUrl || ""),
      model: readModel(els.ollamaModel, els.ollamaModelCustom)
    }
  };

  try {
    await chrome.storage.local.set({ settings });
    setSaveStatus("✓ saved", false);
    setTimeout(() => setSaveStatus("", false), 2000);
  } catch (err) {
    setSaveStatus("Erreur save : " + (err.message || String(err)), true);
  }
}

async function handleOllamaRefresh() {
  setOllamaStatus("Récupération des modèles...", null);
  const baseUrl = els.ollamaUrl.value.trim() || (providerInfo.ollama?.defaultBaseUrl || "");
  els.ollamaRefresh.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "LIST_OLLAMA_MODELS", baseUrl });
    if (!resp || resp.ok !== true) {
      const errMsg = (resp && resp.error) || "réponse vide";
      setOllamaStatus("Ollama injoignable: " + errMsg, "error");
      return;
    }
    const installed = Array.isArray(resp.result) ? resp.result : [];
    const previous = readModel(els.ollamaModel, els.ollamaModelCustom);
    const sugg = providerInfo.ollama ? providerInfo.ollama.suggestedModels : [];
    fillOllamaModelSelect(sugg, installed);
    selectModel(els.ollamaModel, els.ollamaModelCustom, previous, [...installed, ...sugg]);
    setOllamaStatus(
      installed.length > 0
        ? `${installed.length} modèle(s) installé(s) détecté(s).`
        : "Aucun modèle installé sur cette instance.",
      "success"
    );
  } catch (err) {
    setOllamaStatus("Ollama injoignable: " + (err.message || String(err)), "error");
  } finally {
    els.ollamaRefresh.disabled = false;
  }
}

els.save.addEventListener("click", handleSave);
els.ollamaRefresh.addEventListener("click", handleOllamaRefresh);
els.activeProvider.addEventListener("change", () => refreshActiveCard(els.activeProvider.value));
els.geminiKey.addEventListener("input", refreshAudioHint);

init();
