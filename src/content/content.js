"use strict";

console.log(`[autoGymglish] content.js loaded on ${location.href}`);

// Etat module : un seul fill à la fois.
let currentFillState = null;

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // Le popup peut être fermé ; pas d'écouteur → silence.
    });
  } catch (_) {
    // Idem, popup fermé ou contexte indisponible.
  }
}

function handleParse(sendResponse) {
  try {
    if (!window.autoGymglishParser || typeof window.autoGymglishParser.parse !== "function") {
      sendResponse({ error: "parser non chargé" });
      return;
    }
    const result = window.autoGymglishParser.parse();
    sendResponse(result);
  } catch (e) {
    sendResponse({ error: e && e.message ? e.message : String(e) });
  }
}

function ensureFiller() {
  return window.autoGymglishFiller && typeof window.autoGymglishFiller.fill === "function";
}

function startFill(payload) {
  if (!ensureFiller()) {
    broadcast({
      type: "FILL_DONE",
      filled: 0,
      sabotaged: 0,
      unsupportedSkipped: 0,
      audioSkipped: 0,
      errors: [{ id: null, error: "filler non chargé" }],
      aborted: false
    });
    return;
  }
  if (currentFillState && currentFillState.running) {
    console.warn("[autoGymglish/content] Fill déjà en cours, abort puis remplacement.");
    try { window.autoGymglishFiller.abort(); } catch (_) {}
  }

  currentFillState = { running: true };
  const { parserOutput, answers, settings } = payload || {};

  const onProgress = (p) => {
    broadcast(Object.assign({ type: "FILL_PROGRESS" }, p));
  };

  console.debug("[autoGymglish/content] FILL_START reçu", {
    exos: parserOutput && parserOutput.exercises ? parserOutput.exercises.length : 0,
    answers: Array.isArray(answers && answers.answers) ? answers.answers.length : (Array.isArray(answers) ? answers.length : 0),
    settings
  });

  window.autoGymglishFiller
    .fill({ parserOutput, answers, settings, onProgress })
    .then((summary) => {
      currentFillState = { running: false };
      broadcast(Object.assign({ type: "FILL_DONE" }, summary));
    })
    .catch((err) => {
      currentFillState = { running: false };
      broadcast({
        type: "FILL_DONE",
        filled: 0,
        sabotaged: 0,
        unsupportedSkipped: 0,
        audioSkipped: 0,
        errors: [{ id: null, error: (err && err.message) || String(err) }],
        aborted: true
      });
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "PARSE") {
    handleParse(sendResponse);
    return true;
  }

  if (msg.type === "FILL_START") {
    sendResponse({ ok: true });
    // Démarrage async ; les events seront broadcastés via runtime.sendMessage.
    setTimeout(() => startFill(msg.payload), 0);
    return true;
  }

  if (msg.type === "FILL_SKIP_WAIT") {
    if (ensureFiller()) {
      try { window.autoGymglishFiller.skipCurrentWait(); } catch (_) {}
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "FILL_ABORT") {
    if (ensureFiller()) {
      try { window.autoGymglishFiller.abort(); } catch (_) {}
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
