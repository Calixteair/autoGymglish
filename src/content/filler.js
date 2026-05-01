/**
 * autoGymglish — filler.js
 *
 * Remplit les exercices d'une leçon Gymglish (et plus largement A9) à partir
 * d'un parserOutput + des réponses LLM, en simulant des interactions utilisateur :
 *   - délais aléatoires entre exos (configurable),
 *   - sabotage configurable (target_accuracy),
 *   - dispatch des events DOM nécessaires pour que Gymglish accepte la valeur.
 *
 * Expose : window.autoGymglishFiller
 *
 * Vanilla JS, IIFE comme parser.js. Charge sans plantage hors contexte chrome.
 */
(function () {
  'use strict';

  // ----- Config / constantes ---------------------------------------------
  var DEFAULT_MIN_DELAY_MS = 500;
  var DEFAULT_MAX_DELAY_MS = 2000;
  var SABOTAGE_PLAUSIBLE_PROBA = 0.7; // 70 % "plausible", 30 % "je ne sais pas"

  // ----- Logger défensif --------------------------------------------------
  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[autoGymglish/filler]');
      console.warn.apply(console, args);
    } catch (_) {}
  }

  // ----- Helpers généraux -------------------------------------------------
  function randomDelay(min, max) {
    var lo = typeof min === 'number' ? min : DEFAULT_MIN_DELAY_MS;
    var hi = typeof max === 'number' ? max : DEFAULT_MAX_DELAY_MS;
    if (hi < lo) hi = lo;
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  /**
   * Promise résolvable par 3 voies :
   *  - timeout terminé
   *  - skipRef.current() appelée (skip wait)
   *  - signal.aborted déclenché → reject('aborted')
   */
  function waitCancellable(ms, signal, skipRef) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      var timer = setTimeout(function () {
        cleanup();
        resolve();
      }, ms);
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        skipRef.current = null;
      }
      function onAbort() {
        cleanup();
        reject(new Error('aborted'));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      skipRef.current = function () {
        cleanup();
        resolve();
      };
    });
  }

  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function pickRandomDifferent(items, excludedId) {
    var candidates = items.filter(function (x) { return x.id !== excludedId; });
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ----- Sabotage : sélection des exos à saboter --------------------------
  /**
   * Choisit aléatoirement (Fisher-Yates uniforme) les exos à saboter.
   * Audio + unsupported + mixed sont exclus du compteur car déjà skip ailleurs.
   */
  function decideSabotage(exercises, targetAccuracy) {
    var saboteable = exercises.filter(function (ex) {
      return ex && ex.type !== 'unsupported' && ex.type !== 'mixed';
    });
    var total = saboteable.length;
    var accuracy = Math.max(0, Math.min(100, Number(targetAccuracy)));
    var keep = Math.round(total * accuracy / 100);
    var sabotageCount = total - keep;
    if (sabotageCount <= 0) return new Set();

    var ids = saboteable.map(function (ex) { return ex.id; });
    shuffleInPlace(ids);
    return new Set(ids.slice(0, sabotageCount));
  }

  // ----- DOM : dispatch d'events ----------------------------------------
  function dispatch(el, type, init) {
    var Ctor = (init && init.ctor) || Event;
    var opts = (init && init.opts) || { bubbles: true };
    try {
      el.dispatchEvent(new Ctor(type, opts));
    } catch (_) {
      // Fallback ultra-générique
      var e = document.createEvent('Event');
      e.initEvent(type, true, true);
      el.dispatchEvent(e);
    }
  }

  function focusBlur(el, fn) {
    try { el.focus(); } catch (_) {}
    fn();
    try { el.blur(); } catch (_) {}
  }

  // Setter natif pour text inputs : nécessaire pour bypasser React
  function setNativeInputValue(el, value) {
    var proto = HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  // Pour les <select>, le setter natif n'est pas indispensable mais on suit le même pattern.
  function setNativeSelectValue(el, value) {
    var proto = HTMLSelectElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  // ----- DOM : remplissage par type --------------------------------------
  function setRadio(blockEl, choiceId) {
    if (!choiceId) return false;
    var input = blockEl.querySelector('input[type="radio"][value="' + cssEscape(choiceId) + '"]');
    if (!input) return false;
    focusBlur(input, function () {
      input.checked = true;
      dispatch(input, 'input');
      dispatch(input, 'change');
      try { input.click(); } catch (_) {}
    });
    return true;
  }

  function setCheckbox(blockEl, choiceId, desired) {
    var input = blockEl.querySelector('input[type="checkbox"][name="' + cssEscape(choiceId) + '"]');
    if (!input) return false;
    var alreadyMatching = !!input.checked === !!desired;
    if (alreadyMatching) return true;
    focusBlur(input, function () {
      // On utilise click() pour laisser le navigateur toggle nativement.
      try { input.click(); } catch (_) { input.checked = !!desired; }
      dispatch(input, 'input');
      dispatch(input, 'change');
    });
    return true;
  }

  function setSelect(blockEl, selectName, optionId) {
    var select = blockEl.querySelector('select[name="' + cssEscape(selectName) + '"]');
    if (!select) return false;
    focusBlur(select, function () {
      setNativeSelectValue(select, optionId);
      dispatch(select, 'input');
      dispatch(select, 'change');
    });
    return true;
  }

  function setTextInput(blockEl, blankName, value) {
    var input = blockEl.querySelector('input[type="text"][name="' + cssEscape(blankName) + '"]');
    if (!input) return false;
    try { input.focus(); } catch (_) {}
    setNativeInputValue(input, value);
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    } catch (_) {
      dispatch(input, 'input');
    }
    dispatch(input, 'change');
    try {
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    } catch (_) {
      try { input.blur(); } catch (__) {}
    }
    return true;
  }

  /**
   * CSS.escape n'est pas universel ; on garde un fallback minimal pour les
   * caractères non-alphanumériques rencontrés dans les noms Gymglish (chiffres
   * collés, tirets-bas, etc.). Les ids du parser sont ASCII donc le risque est faible.
   */
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    return String(s).replace(/(["\\\[\]:.])/g, '\\$1');
  }

  // ----- Sabotage : construction de la valeur fautive --------------------
  /**
   * Pour radio/checkbox : retrouver l'option "Je ne sais pas" dans le DOM (le
   * parser l'exclut volontairement de exercise.choices).
   */
  function findIdkChoiceInput(blockEl, kind) {
    if (!blockEl) return null;
    var sel = kind === 'checkbox'
      ? '.a9c-choice-idontknow input[type="checkbox"], .idontknow-mod input[type="checkbox"]'
      : '.a9c-choice-idontknow input[type="radio"]';
    return blockEl.querySelector(sel);
  }

  function findIdkOptionId(blockEl, selectName) {
    var select = blockEl.querySelector('select[name="' + cssEscape(selectName) + '"]');
    if (!select) return null;
    var opt = select.querySelector('option.dontknowchoice');
    return opt ? opt.value : null;
  }

  function alterTextAnswer(value) {
    if (typeof value !== 'string' || !value) return '';
    // Stratégies simples : retirer un 's' final, doubler une lettre ou changer une voyelle.
    if (/s$/i.test(value) && value.length > 1) {
      return value.slice(0, -1);
    }
    var vowels = ['a', 'e', 'i', 'o', 'u'];
    var idx = -1;
    for (var i = 0; i < value.length; i++) {
      if (vowels.indexOf(value[i].toLowerCase()) !== -1) { idx = i; break; }
    }
    if (idx >= 0) {
      var nextVowel = vowels[(vowels.indexOf(value[idx].toLowerCase()) + 1) % vowels.length];
      return value.slice(0, idx) + nextVowel + value.slice(idx + 1);
    }
    // Dernier recours : ajouter un 'x' final.
    return value + 'x';
  }

  /**
   * Calcule la "réponse sabotée" pour un exo + sa réponse LLM.
   * Retourne `null` si on ne sait pas saboter (le filler tombera alors sur
   * la stratégie "remplir normalement").
   */
  function sabotageAnswer(exercise, answer, blockEl) {
    var idkPath = Math.random() >= SABOTAGE_PLAUSIBLE_PROBA;
    if (exercise.type === 'radio-single') {
      return sabotageRadio(exercise, answer, blockEl, idkPath);
    }
    if (exercise.type === 'checkbox-multiple') {
      return sabotageCheckbox(exercise, answer, blockEl, idkPath);
    }
    if (exercise.type === 'dropdown') {
      return sabotageDropdown(exercise, answer, blockEl, idkPath);
    }
    if (exercise.type === 'text-conjugation') {
      return sabotageText(exercise, answer, idkPath);
    }
    if (exercise.type === 'text-dictation') {
      // Pas de bouton "I don't know" pour la dictée → on force la voie typo.
      return sabotageText(exercise, answer, false);
    }
    return null;
  }

  function sabotageRadio(exercise, answer, blockEl, idkPath) {
    if (idkPath) {
      var idk = findIdkChoiceInput(blockEl, 'radio');
      if (idk) return { selected: [idk.value || idk.getAttribute('id')] };
    }
    var picked = answer && answer.selected && answer.selected[0];
    var alt = pickRandomDifferent(exercise.choices || [], picked);
    if (alt) return { selected: [alt.id] };
    if (picked) return { selected: [picked] };
    return null;
  }

  function sabotageCheckbox(exercise, answer, blockEl, idkPath) {
    if (idkPath) {
      var idk = findIdkChoiceInput(blockEl, 'checkbox');
      if (idk) return { selected: [], idkCheckbox: idk };
    }
    var correct = (answer && Array.isArray(answer.selected)) ? answer.selected.slice() : [];
    var allIds = (exercise.choices || []).map(function (c) { return c.id; });
    if (!allIds.length) return { selected: correct };
    // Inverser 1 à 2 cases : prendre 1-2 ids random parmi tous, et toggle dans `correct`.
    var nbToggle = Math.random() < 0.5 ? 1 : 2;
    var pool = allIds.slice();
    shuffleInPlace(pool);
    for (var i = 0; i < Math.min(nbToggle, pool.length); i++) {
      var id = pool[i];
      var idx = correct.indexOf(id);
      if (idx === -1) correct.push(id); else correct.splice(idx, 1);
    }
    return { selected: correct };
  }

  function sabotageDropdown(exercise, answer, blockEl, idkPath) {
    var dropdowns = exercise.dropdowns || [];
    var dd = answer && answer.dropdowns ? Object.assign({}, answer.dropdowns) : {};
    for (var i = 0; i < dropdowns.length; i++) {
      var d = dropdowns[i];
      if (idkPath) {
        var idkId = findIdkOptionId(blockEl, d.id);
        if (idkId) { dd[d.id] = idkId; continue; }
      }
      var current = dd[d.id];
      var alt = pickRandomDifferent(d.options || [], current);
      if (alt) dd[d.id] = alt.id;
    }
    return { dropdowns: dd };
  }

  function sabotageText(exercise, answer, idkPath) {
    var blanks = exercise.blanks || [];
    var src = (answer && answer.blanks) ? answer.blanks : {};
    var bank = Array.isArray(exercise.wordBank) ? exercise.wordBank : null;
    var out = {};
    for (var i = 0; i < blanks.length; i++) {
      var bid = blanks[i].id;
      var correct = src[bid] || '';
      if (idkPath) {
        out[bid] = '';
      } else if (bank && bank.length > 1) {
        // wordBank dispo (ex. "should | would | could") → choisir un mot DIFFÉRENT du bank :
        // erreur plausible plutôt qu'une typo dans le bon mot.
        out[bid] = pickOtherFromBank(bank, correct);
      } else {
        out[bid] = alterTextAnswer(correct);
      }
    }
    return { blanks: out };
  }

  function pickOtherFromBank(bank, correct) {
    var others = bank.filter(function (w) { return w && w !== correct; });
    if (others.length === 0) return alterTextAnswer(correct);
    return others[Math.floor(Math.random() * others.length)];
  }

  // ----- Application d'une réponse au DOM --------------------------------
  function applyAnswer(blockEl, exercise, finalAnswer) {
    var ok = true;
    if (exercise.type === 'radio-single') {
      var sel = (finalAnswer.selected || [])[0];
      ok = setRadio(blockEl, sel);
      return ok;
    }
    if (exercise.type === 'checkbox-multiple') {
      var picked = new Set(finalAnswer.selected || []);
      var choices = exercise.choices || [];
      for (var i = 0; i < choices.length; i++) {
        setCheckbox(blockEl, choices[i].id, picked.has(choices[i].id));
      }
      // Si le path "Je ne sais pas" a été choisi en sabotage, cliquer la case dédiée.
      if (finalAnswer.idkCheckbox) {
        var idk = finalAnswer.idkCheckbox;
        if (!idk.checked) {
          focusBlur(idk, function () {
            try { idk.click(); } catch (_) { idk.checked = true; }
            dispatch(idk, 'input');
            dispatch(idk, 'change');
          });
        }
      }
      return true;
    }
    if (exercise.type === 'dropdown') {
      var dd = finalAnswer.dropdowns || {};
      var allOk = true;
      var ids = Object.keys(dd);
      for (var k = 0; k < ids.length; k++) {
        if (!setSelect(blockEl, ids[k], dd[ids[k]])) allOk = false;
      }
      return allOk;
    }
    if (exercise.type === 'text-conjugation' || exercise.type === 'text-dictation') {
      var bl = finalAnswer.blanks || {};
      var blanks = exercise.blanks || [];
      var allTxtOk = true;
      for (var b = 0; b < blanks.length; b++) {
        var bid = blanks[b].id;
        var val = Object.prototype.hasOwnProperty.call(bl, bid) ? bl[bid] : '';
        if (!setTextInput(blockEl, bid, val)) allTxtOk = false;
      }
      return allTxtOk;
    }
    return false;
  }

  // ----- Pipeline pour un exercice ---------------------------------------
  /**
   * Exécute le sabotage (si demandé) puis applique la réponse au DOM. Retourne
   * { status: 'filled'|'sabotaged'|'unsupported'|'audio-skipped'|'error', error? }
   */
  function fillExercise(exercise, answer, options) {
    var doc = options.document || document;
    var willSabotage = !!options.willSabotage;
    if (exercise.type === 'unsupported' || exercise.type === 'mixed') {
      warn('Type non supporté skippé', exercise.id, exercise.type);
      return { status: 'unsupported' };
    }
    var blockEl = doc.querySelector(exercise.domSelector);
    if (!blockEl) {
      warn('Bloc introuvable', exercise.id, exercise.domSelector);
      return { status: 'error', error: 'block-not-found' };
    }
    if (!answer) {
      warn('Réponse LLM manquante', exercise.id);
      return { status: 'error', error: 'missing-answer' };
    }
    var finalAnswer = willSabotage ? (sabotageAnswer(exercise, answer, blockEl) || answer) : answer;
    try {
      var ok = applyAnswer(blockEl, exercise, finalAnswer);
      if (!ok) return { status: 'error', error: 'apply-failed' };
      return { status: willSabotage ? 'sabotaged' : 'filled' };
    } catch (err) {
      warn('Échec applyAnswer', exercise.id, err);
      return { status: 'error', error: (err && err.message) || String(err) };
    }
  }

  // ----- API publique : fill() -------------------------------------------
  var skipRef = { current: null };
  var abortController = null;

  function indexAnswers(answers) {
    var idx = {};
    if (!Array.isArray(answers)) return idx;
    for (var i = 0; i < answers.length; i++) {
      var a = answers[i];
      if (a && typeof a.exerciseId === 'string') idx[a.exerciseId] = a;
    }
    return idx;
  }

  /**
   * Lance le remplissage. Renvoie une Promise<FillSummary>.
   * onProgress({index,total,exerciseId,status,...}) appelé après chaque exo.
   */
  function fill(args) {
    args = args || {};
    var parserOutput = args.parserOutput || {};
    var answersList = (args.answers && args.answers.answers) || args.answers || [];
    var settings = args.settings || {};
    var onProgress = typeof args.onProgress === 'function' ? args.onProgress : function () {};

    abortController = new AbortController();
    var externalSignal = args.signal;
    if (externalSignal) {
      externalSignal.addEventListener('abort', function () { abortController.abort(); }, { once: true });
    }
    var signal = abortController.signal;

    var exercises = Array.isArray(parserOutput.exercises) ? parserOutput.exercises : [];
    var sabotagedSet = decideSabotage(exercises, settings.targetAccuracy != null ? settings.targetAccuracy : 100);
    var audioSkipped = (parserOutput.skipped || []).filter(function (s) {
      return s && typeof s.reason === 'string' && s.reason.indexOf('audio') === 0;
    }).length;
    var idx = indexAnswers(answersList);

    return runLoop({
      exercises: exercises,
      sabotagedSet: sabotagedSet,
      answersIdx: idx,
      settings: settings,
      onProgress: onProgress,
      signal: signal,
      audioSkipped: audioSkipped
    });
  }

  function runLoop(ctx) {
    var summary = {
      filled: 0, sabotaged: 0, unsupportedSkipped: 0,
      audioSkipped: ctx.audioSkipped, errors: [], aborted: false
    };
    var total = ctx.exercises.length;
    var minD = ctx.settings.minDelayMs != null ? ctx.settings.minDelayMs : DEFAULT_MIN_DELAY_MS;
    var maxD = ctx.settings.maxDelayMs != null ? ctx.settings.maxDelayMs : DEFAULT_MAX_DELAY_MS;

    var p = Promise.resolve();
    ctx.exercises.forEach(function (ex, i) {
      p = p.then(function () {
        if (ctx.signal.aborted) {
          summary.aborted = true;
          throw new Error('aborted');
        }
        return waitCancellable(randomDelay(minD, maxD), ctx.signal, skipRef);
      }).then(function () {
        var willSab = ctx.sabotagedSet.has(ex.id);
        var res = fillExercise(ex, ctx.answersIdx[ex.id], { willSabotage: willSab });
        if (res.status === 'filled') summary.filled++;
        else if (res.status === 'sabotaged') summary.sabotaged++;
        else if (res.status === 'unsupported') summary.unsupportedSkipped++;
        else if (res.status === 'error') summary.errors.push({ id: ex.id, error: res.error });
        ctx.onProgress({
          index: i, total: total, exerciseId: ex.id, status: res.status,
          audioSkipped: ctx.audioSkipped,
          sabotagedSoFar: summary.sabotaged,
          errors: summary.errors.slice()
        });
      }).catch(function (err) {
        if (err && err.message === 'aborted') {
          summary.aborted = true;
          throw err;
        }
        warn('Erreur boucle exo', ex.id, err);
        summary.errors.push({ id: ex.id, error: (err && err.message) || String(err) });
      });
    });
    return p.then(function () { return summary; }, function (err) {
      if (err && err.message === 'aborted') {
        summary.aborted = true;
        return summary;
      }
      throw err;
    });
  }

  function skipCurrentWait() {
    if (typeof skipRef.current === 'function') {
      skipRef.current();
    }
  }

  function abort() {
    if (abortController) abortController.abort();
  }

  // ----- Exposition globale ---------------------------------------------
  var api = {
    fill: fill,
    skipCurrentWait: skipCurrentWait,
    abort: abort,
    _internals: {
      decideSabotage: decideSabotage,
      sabotageAnswer: sabotageAnswer,
      fillExercise: fillExercise,
      randomDelay: randomDelay,
      waitCancellable: waitCancellable,
      alterTextAnswer: alterTextAnswer,
      shuffleInPlace: shuffleInPlace,
      findIdkChoiceInput: findIdkChoiceInput,
      findIdkOptionId: findIdkOptionId,
      cssEscape: cssEscape
    }
  };

  if (typeof window !== 'undefined') {
    window.autoGymglishFiller = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
