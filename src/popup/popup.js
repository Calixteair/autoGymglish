"use strict";

const detectBtn = document.getElementById("detect");
const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const providerSelect = document.getElementById("provider-select");
const solveBtn = document.getElementById("solve-test");
const solveResultEl = document.getElementById("solve-result");
const openSettingsBtn = document.getElementById("open-settings");
const accuracySlider = document.getElementById("accuracy-slider");
const accuracyValue = document.getElementById("accuracy-value");
const solveAndFillBtn = document.getElementById("solve-and-fill");
const fillProgressEl = document.getElementById("fill-progress");
const fillStatusEl = document.getElementById("fill-status");
const audioCounterEl = document.getElementById("audio-counter");
const progressFillEl = fillProgressEl.querySelector(".progress-fill");
const skipWaitBtn = document.getElementById("skip-wait");
const stopFillBtn = document.getElementById("stop-fill");

const FILL_DEFAULTS = { minDelayMs: 500, maxDelayMs: 2000 };

let uiState = "idle";
let activeTabId = null;
let accuracySaveTimer = null;

function setResult(text) {
  resultEl.textContent = text;
}

function clearSolveResult() {
  solveResultEl.replaceChildren();
}

function setSolveError(msg) {
  clearSolveResult();
  const span = document.createElement("span");
  span.className = "sr-error";
  span.textContent = msg;
  solveResultEl.appendChild(span);
}

function setSolveSuccess({ providerId, model, validation, answers }) {
  clearSolveResult();

  const title = document.createElement("span");
  title.className = "sr-title";
  title.textContent = "> Solve result:";
  solveResultEl.appendChild(title);

  const head = document.createElement("span");
  const modelLabel = model ? ` (${model})` : "";
  const valLabel = validation && validation.valid
    ? `OK | ${answers.length} answers`
    : `INVALID | ${answers.length} answers`;
  head.textContent = `Provider: ${providerId}${modelLabel}\nValidation: ${valLabel}\n\n`;
  solveResultEl.appendChild(head);

  if (validation && !validation.valid && Array.isArray(validation.errors) && validation.errors.length > 0) {
    const warn = document.createElement("span");
    warn.className = "sr-warn";
    warn.textContent = "Validation errors:\n" + validation.errors.map((e) => "  - " + e).join("\n") + "\n\n";
    solveResultEl.appendChild(warn);
  }

  const body = document.createElement("span");
  body.textContent = JSON.stringify(answers, null, 2);
  solveResultEl.appendChild(body);
}

function formatSummary(data) {
  const exercises = Array.isArray(data.exercises) ? data.exercises : [];
  const total = exercises.length;
  const active = exercises.filter((e) => e && !e.skipped && e.type !== "unsupported").length;
  const skipped = exercises.filter((e) => e && e.skipped).length;
  const unsupported = exercises.filter((e) => e && e.type === "unsupported").length;

  const lines = [`Total: ${total} | Active: ${active} | Skipped: ${skipped} | Unsupported: ${unsupported}`];

  for (const ex of exercises) {
    if (!ex) continue;
    const id = ex.id || "?";
    const type = ex.type || "?";
    let count = "";
    if (Array.isArray(ex.choices)) count = ` choices=${ex.choices.length}`;
    else if (Array.isArray(ex.blanks)) count = ` blanks=${ex.blanks.length}`;
    lines.push(`- ${id} [${type}]${count}`);
  }

  return lines.join("\n");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    throw new Error("Aucun onglet actif détecté.");
  }
  return tab;
}

async function parseActiveTab() {
  const tab = await getActiveTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "PARSE" });
  } catch (_sendErr) {
    throw new Error(
      "Le content script n'est pas chargé sur cette page. Es-tu sur une page de leçon Gymglish ?"
    );
  }
  if (!response) throw new Error("Réponse vide du content script.");
  if (response.error) throw new Error(`Content script: ${response.error}`);
  return response;
}

async function handleDetect() {
  setResult("");
  statusEl.textContent = "parsing...";

  try {
    const response = await parseActiveTab();
    const summary = formatSummary(response);
    const json = JSON.stringify(response, null, 2);
    setResult(`${summary}\n\n${json}`);
    console.debug("[autoGymglish/popup] Parser result:", response);
    statusEl.textContent = "ready";
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setResult(`Erreur: ${msg}`);
    statusEl.textContent = "ready";
    console.warn("[autoGymglish/popup] Detect failed:", err);
  }
}

async function loadProvidersAndSettings() {
  let providersResp;
  try {
    providersResp = await chrome.runtime.sendMessage({ type: "GET_PROVIDERS" });
  } catch (err) {
    console.warn("[autoGymglish/popup] GET_PROVIDERS failed:", err);
    return;
  }
  if (!providersResp || providersResp.ok !== true) {
    console.warn("[autoGymglish/popup] GET_PROVIDERS bad response:", providersResp);
    return;
  }
  const providers = providersResp.result?.providers || [];
  const stored = await chrome.storage.local.get("settings");
  const settings = stored.settings || {};
  const currentProvider = settings.provider || (providers[0] && providers[0].id);

  providerSelect.replaceChildren();
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label || p.id;
    if (p.id === currentProvider) opt.selected = true;
    providerSelect.appendChild(opt);
  }

  applyAccuracyToUI(readAccuracyFromSettings(settings));
}

function readAccuracyFromSettings(settings) {
  const v = settings && settings.targetAccuracy;
  if (typeof v !== "number" || Number.isNaN(v)) return 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function applyAccuracyToUI(value) {
  accuracySlider.value = String(value);
  accuracyValue.textContent = `${value}%`;
  applyRiskState(value);
}

function applyRiskState(value) {
  const risk = value < 50 ? "high" : value < 80 ? "med" : "low";
  document.body.dataset.risk = risk;
  const tag = document.getElementById("risk-tag");
  if (tag) tag.textContent = risk === "high" ? "sloppy" : risk === "med" ? "plausible" : "honest";
}

async function onProviderChange() {
  const newProvider = providerSelect.value;
  const stored = await chrome.storage.local.get("settings");
  const settings = stored.settings || {};
  settings.provider = newProvider;
  await chrome.storage.local.set({ settings });
}

function onAccuracyInput() {
  const value = Number(accuracySlider.value);
  accuracyValue.textContent = `${value}%`;
  applyRiskState(value);
  if (accuracySaveTimer) clearTimeout(accuracySaveTimer);
  accuracySaveTimer = setTimeout(() => persistAccuracy(value), 200);
}

async function persistAccuracy(value) {
  try {
    const stored = await chrome.storage.local.get("settings");
    const settings = stored.settings || {};
    settings.targetAccuracy = value;
    await chrome.storage.local.set({ settings });
  } catch (err) {
    console.warn("[autoGymglish/popup] save accuracy failed:", err);
  }
}

async function handleSolveTest() {
  clearSolveResult();
  solveBtn.disabled = true;
  const originalLabel = solveBtn.textContent;
  solveBtn.textContent = "Solving...";

  try {
    let parserOutput;
    try {
      parserOutput = await parseActiveTab();
    } catch (err) {
      setSolveError("Erreur parser : " + (err.message || String(err)));
      return;
    }

    const exercises = Array.isArray(parserOutput.exercises) ? parserOutput.exercises : [];
    const active = exercises.filter((e) => e && !e.skipped && e.type !== "unsupported");
    const unsupported = exercises.filter((e) => e && e.type === "unsupported");

    if (active.length === 0) {
      setSolveError("Aucun exercice actif à résoudre sur cette page.");
      return;
    }
    if (unsupported.length > 0) {
      setSolveError(
        `Exercices non supportés détectés (${unsupported.length}). ` +
          "Corrige le parser avant d'envoyer au LLM."
      );
      return;
    }

    let solveResp;
    try {
      solveResp = await chrome.runtime.sendMessage({ type: "SOLVE", payload: parserOutput });
    } catch (err) {
      setSolveError("Erreur communication SW : " + (err.message || String(err)));
      return;
    }

    if (!solveResp) {
      setSolveError("Réponse vide du service worker.");
      return;
    }
    if (solveResp.ok !== true) {
      setSolveError("Erreur LLM : " + (solveResp.error || "inconnue"));
      return;
    }

    const result = solveResp.result || {};
    setSolveSuccess({
      providerId: result.provider || providerSelect.value,
      model: result.model,
      validation: result.validation,
      answers: result.answers || []
    });
    console.debug("[autoGymglish/popup] Solve result:", result);
  } finally {
    solveBtn.disabled = false;
    solveBtn.textContent = originalLabel;
  }
}

function setUiState(next) {
  uiState = next;
  const isSolving = next === "solving";
  const isFilling = next === "filling";
  const isBusy = isSolving || isFilling;

  detectBtn.disabled = isBusy;
  solveBtn.disabled = isBusy;
  providerSelect.disabled = isBusy;
  openSettingsBtn.disabled = isBusy;
  solveAndFillBtn.disabled = isBusy;

  setPrimaryButtonContent(isSolving ? "solving..." : isFilling ? "filling..." : "Solve & Fill", !isBusy);
  statusEl.textContent = isSolving ? "calling LLM..." : isFilling ? "filling DOM..." : next === "done" ? "done" : "ready";

  skipWaitBtn.disabled = !isFilling;
  stopFillBtn.disabled = !isFilling;
}

function setPrimaryButtonContent(label, withArrow) {
  const labelEl = solveAndFillBtn.querySelector(".btn-label");
  const arrowEl = solveAndFillBtn.querySelector(".btn-arrow");
  if (labelEl) labelEl.textContent = label;
  if (arrowEl) arrowEl.style.opacity = withArrow ? "1" : "0";
}

function showFillProgress(total) {
  fillProgressEl.hidden = false;
  progressFillEl.style.width = "0%";
  fillStatusEl.textContent = `0 / ${total} exercises filled`;
  audioCounterEl.textContent = "0 audio exercises skipped";
}

function updateFillProgress({ index, total, audioSkipped }) {
  const safeTotal = Math.max(1, total || 0);
  const pct = Math.min(100, Math.round((index / safeTotal) * 100));
  progressFillEl.style.width = `${pct}%`;
  fillStatusEl.textContent = `${index} / ${total} exercises filled`;
  audioCounterEl.textContent = `${audioSkipped || 0} audio exercises skipped`;
}

function finalizeFillUi(payload) {
  const { filled = 0, sabotaged = 0, audioSkipped = 0, errors = [], aborted = false } = payload || {};
  if (aborted) {
    fillStatusEl.textContent = `Filling stopped (${filled} filled, ${sabotaged} sabotaged)`;
  } else if (errors.length > 0) {
    fillStatusEl.textContent = `Filled ${filled} with ${errors.length} error(s) — see console`;
    console.warn("[autoGymglish/popup] Fill errors:", errors);
  } else {
    fillStatusEl.textContent = `Done — ${filled} filled, ${sabotaged} sabotaged`;
  }
  audioCounterEl.textContent = `${audioSkipped} audio exercises skipped`;
  progressFillEl.style.width = "100%";
  setUiState("done");
}

function detachFillListener() {
  if (typeof onFillRuntimeMessage === "function") {
    chrome.runtime.onMessage.removeListener(onFillRuntimeMessage);
  }
}

function onFillRuntimeMessage(msg, sender) {
  if (!msg || (sender && typeof sender.tab?.id === "number" && sender.tab.id !== activeTabId)) return;
  if (msg.type === "FILL_PROGRESS") {
    updateFillProgress(msg.payload || {});
    return;
  }
  if (msg.type === "FILL_DONE") {
    finalizeFillUi(msg.payload || {});
    detachFillListener();
  }
}

async function runSolveStep() {
  const parserOutput = await parseActiveTab();
  const exercises = Array.isArray(parserOutput.exercises) ? parserOutput.exercises : [];
  const active = exercises.filter((e) => e && !e.skipped && e.type !== "unsupported");
  const unsupported = exercises.filter((e) => e && e.type === "unsupported");

  if (active.length === 0) throw new Error("Aucun exercice actif à résoudre sur cette page.");
  if (unsupported.length > 0) {
    throw new Error(
      `Exercices non supportés détectés (${unsupported.length}). Corrige le parser avant d'envoyer au LLM.`
    );
  }

  const solveResp = await chrome.runtime.sendMessage({ type: "SOLVE", payload: parserOutput });
  if (!solveResp) throw new Error("Réponse vide du service worker.");
  if (solveResp.ok !== true) throw new Error(solveResp.error || "Erreur LLM inconnue");
  const result = solveResp.result || {};
  const llmSkipped = Array.isArray(result.skipped) ? result.skipped : [];
  if (llmSkipped.length > 0) {
    parserOutput.skipped = (parserOutput.skipped || []).concat(llmSkipped);
  }
  return { parserOutput, answers: result.answers || [], result };
}

async function startFilling({ tabId, parserOutput, answers, targetAccuracy }) {
  const total = (parserOutput.exercises || []).filter((e) => e && !e.skipped && e.type !== "unsupported").length;
  showFillProgress(total);
  setUiState("filling");

  chrome.runtime.onMessage.addListener(onFillRuntimeMessage);

  const fillMsg = {
    type: "FILL_START",
    payload: {
      parserOutput,
      answers,
      settings: { targetAccuracy, ...FILL_DEFAULTS }
    }
  };

  try {
    await chrome.tabs.sendMessage(tabId, fillMsg);
  } catch (err) {
    detachFillListener();
    finalizeFillUi({ aborted: true, errors: [err.message || String(err)] });
    fillStatusEl.textContent = "Erreur envoi FILL_START : " + (err.message || String(err));
  }
}

async function handleSolveAndFill() {
  if (uiState === "solving" || uiState === "filling") return;
  clearSolveResult();
  fillProgressEl.hidden = true;

  let tab;
  try {
    tab = await getActiveTab();
  } catch {
    alert("Pas de leçon Gymglish détectée.");
    return;
  }
  activeTabId = tab.id;

  setUiState("solving");
  let solved;
  try {
    solved = await runSolveStep();
  } catch (err) {
    setSolveError(err.message || String(err));
    setUiState("idle");
    return;
  }

  setSolveSuccess({
    providerId: solved.result.provider || providerSelect.value,
    model: solved.result.model,
    validation: solved.result.validation,
    answers: solved.answers
  });
  console.debug("[autoGymglish/popup] Solve OK, starting fill");

  const targetAccuracy = Number(accuracySlider.value);
  await startFilling({
    tabId: activeTabId,
    parserOutput: solved.parserOutput,
    answers: solved.answers,
    targetAccuracy
  });
}

async function sendToActiveTab(type) {
  if (activeTabId == null) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type });
  } catch (err) {
    console.warn(`[autoGymglish/popup] ${type} send failed:`, err);
  }
}

function handleSkipWait() {
  sendToActiveTab("FILL_SKIP_WAIT");
}

function handleStopFill() {
  sendToActiveTab("FILL_ABORT");
}

function handleOpenSettings() {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/popup/settings.html") });
}

detectBtn.addEventListener("click", handleDetect);
providerSelect.addEventListener("change", onProviderChange);
solveBtn.addEventListener("click", handleSolveTest);
openSettingsBtn.addEventListener("click", handleOpenSettings);
accuracySlider.addEventListener("input", onAccuracyInput);
solveAndFillBtn.addEventListener("click", handleSolveAndFill);
skipWaitBtn.addEventListener("click", handleSkipWait);
stopFillBtn.addEventListener("click", handleStopFill);

setUiState("idle");

loadProvidersAndSettings().catch((err) => {
  console.warn("[autoGymglish/popup] init failed:", err);
});
