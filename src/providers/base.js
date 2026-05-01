/**
 * autoGymglish — providers/base.js
 *
 * Base commune pour les providers LLM (gemini, claude, ollama).
 * - SYSTEM_PROMPT : prompt système commun
 * - buildUserPrompt(payload) : sérialise un payload parser en prompt user
 * - RESPONSE_SCHEMA : JSON Schema strict de la réponse attendue
 * - parseLLMResponse(rawText) : extrait/parse le JSON tolérant aux ```json
 * - validateAnswers(answers, payload) : vérifie la cohérence sémantique
 *
 * Module utilisable :
 *   - dans un service worker MV3 (via globalThis.autoGymglishBase)
 *   - en Node pour les tests (via module.exports)
 */
(function (global) {
  'use strict';

  // ----- Prompt système ---------------------------------------------------
  var SYSTEM_PROMPT = [
    'You are a meticulous language assistant that solves Gymglish-style language exercises (English, French, German, Spanish, Italian — see "Language" field).',
    'The user provides a dialogue context from the lesson and a list of exercises. For each exercise, give THE single correct answer according to the rules of the target language and the context.',
    '',
    'Exercise types and how to answer:',
    '- "radio-single": choose exactly ONE id from "choices". Put it in "selected" as a single-element array.',
    '- "checkbox-multiple": choose ALL the correct ids from "choices" (one or more). Never pick a "Je ne sais pas" / "I don\'t know" option. Put the ids in "selected".',
    '- "dropdown": for each entry in "dropdowns", choose ONE option id from its "options". Return a "dropdowns" object mapping each dropdown.id to the chosen option id.',
    '- "text-conjugation": for each entry in "blanks", give the exact word or conjugated form to type. Use the "verb" / "hint" field if provided. If the exercise has a "wordBank" array, you MUST only use words from it (a word may be reused if the exercise allows). Return a "blanks" object mapping each blank.id to the chosen string.',
    '- "text-dictation": same as text-conjugation but the words come from an audio recording attached to the request. Listen to the audio and return a "blanks" object mapping each blank.id to the exact word(s) heard at that position. The blanks appear in the order they should be filled.',
    '',
    'Hard constraints:',
    '- Answer ONLY with valid JSON matching the provided response schema. No markdown, no code fences, no prose, no comments.',
    '- Provide one answer object per exercise, identified by its "exerciseId".',
    '- Do not invent ids: every id must come from the corresponding exercise.'
  ].join('\n');

  // ----- Prompt user ------------------------------------------------------
  function buildUserPrompt(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('buildUserPrompt: payload must be an object');
    }
    var lang = payload.productLang || 'unknown';
    var ctx = payload.context || '(no dialogue context)';
    var exercises = Array.isArray(payload.exercises) ? payload.exercises : [];
    var serialized = JSON.stringify({ exercises: exercises }, null, 2);
    var hasDictation = exercises.some(function (e) { return e && e.type === 'text-dictation'; });
    var lines = [
      'Language: ' + lang,
      '',
      'Context (dialogue from the lesson):',
      '"""',
      ctx,
      '"""',
      ''
    ];
    if (hasDictation) {
      lines.push(
        'Audio attachments are provided in the same order as the text-dictation exercises listed below. Audio #1 corresponds to the first text-dictation exercise, etc.',
        ''
      );
    }
    lines.push(
      'Solve the following exercises. Respond with a single JSON object matching the response schema.',
      '',
      'Exercises:',
      serialized
    );
    return lines.join('\n');
  }

  // ----- JSON Schema strict ----------------------------------------------
  var RESPONSE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['answers'],
    additionalProperties: false,
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['exerciseId'],
          additionalProperties: false,
          properties: {
            exerciseId: { type: 'string' },
            selected: { type: 'array', items: { type: 'string' } },
            dropdowns: { type: 'object', additionalProperties: { type: 'string' } },
            blanks: { type: 'object', additionalProperties: { type: 'string' } }
          }
        }
      }
    }
  };

  // ----- Parsing tolérant -------------------------------------------------
  function stripCodeFences(s) {
    var trimmed = s.trim();
    // ```json ... ``` ou ``` ... ```
    var fenced = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
    if (fenced) return fenced[1].trim();
    return trimmed;
  }

  function extractJsonRange(s) {
    var first = s.indexOf('{');
    var last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    return s.slice(first, last + 1);
  }

  function parseLLMResponse(rawText) {
    if (typeof rawText !== 'string') {
      throw new Error('LLM returned invalid JSON: input is not a string');
    }
    var cleaned = stripCodeFences(rawText);
    // Tente parse direct
    try {
      return JSON.parse(cleaned);
    } catch (_) {}
    // Fallback : extraire entre premier { et dernier }
    var range = extractJsonRange(cleaned);
    if (range) {
      try {
        return JSON.parse(range);
      } catch (err) {
        throw new Error('LLM returned invalid JSON: ' + err.message);
      }
    }
    throw new Error('LLM returned invalid JSON: no JSON object found');
  }

  // ----- Validation sémantique -------------------------------------------
  function indexExercises(payload) {
    var idx = {};
    var list = (payload && Array.isArray(payload.exercises)) ? payload.exercises : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id) idx[list[i].id] = list[i];
    }
    return idx;
  }

  function validateRadioSingle(answer, exercise, errors) {
    var sel = answer.selected;
    if (!Array.isArray(sel) || sel.length !== 1) {
      errors.push(exercise.id + ': radio-single requires "selected" array of length 1');
      return;
    }
    var ids = (exercise.choices || []).map(function (c) { return c.id; });
    if (ids.indexOf(sel[0]) === -1) {
      errors.push(exercise.id + ': selected id "' + sel[0] + '" not in choices');
    }
  }

  function validateCheckboxMultiple(answer, exercise, errors) {
    var sel = answer.selected;
    if (!Array.isArray(sel) || sel.length === 0) {
      errors.push(exercise.id + ': checkbox-multiple requires non-empty "selected" array');
      return;
    }
    var ids = (exercise.choices || []).map(function (c) { return c.id; });
    for (var i = 0; i < sel.length; i++) {
      if (ids.indexOf(sel[i]) === -1) {
        errors.push(exercise.id + ': selected id "' + sel[i] + '" not in choices');
      }
    }
  }

  function validateDropdown(answer, exercise, errors) {
    var dd = answer.dropdowns;
    if (!dd || typeof dd !== 'object') {
      errors.push(exercise.id + ': dropdown requires "dropdowns" object');
      return;
    }
    var dropdowns = exercise.dropdowns || [];
    for (var i = 0; i < dropdowns.length; i++) {
      var d = dropdowns[i];
      if (!Object.prototype.hasOwnProperty.call(dd, d.id)) {
        errors.push(exercise.id + ': missing dropdown "' + d.id + '"');
        continue;
      }
      var chosen = dd[d.id];
      var validIds = (d.options || []).map(function (o) { return o.id; });
      if (validIds.indexOf(chosen) === -1) {
        errors.push(exercise.id + '.' + d.id + ': option "' + chosen + '" not in valid options');
      }
    }
  }

  function validateTextConjugation(answer, exercise, errors) {
    var bl = answer.blanks;
    if (!bl || typeof bl !== 'object') {
      errors.push(exercise.id + ': text-conjugation requires "blanks" object');
      return;
    }
    var blanks = exercise.blanks || [];
    var bank = Array.isArray(exercise.wordBank) ? exercise.wordBank : null;
    for (var i = 0; i < blanks.length; i++) {
      var b = blanks[i];
      if (!Object.prototype.hasOwnProperty.call(bl, b.id)) {
        errors.push(exercise.id + ': missing blank "' + b.id + '"');
        continue;
      }
      var val = bl[b.id];
      if (typeof val !== 'string' || val.trim() === '') {
        errors.push(exercise.id + '.' + b.id + ': value must be a non-empty string');
        continue;
      }
      if (bank && bank.indexOf(val) === -1) {
        errors.push(exercise.id + '.' + b.id + ': value "' + val + '" not in wordBank');
      }
    }
  }

  var DISPATCH = {
    'radio-single': validateRadioSingle,
    'checkbox-multiple': validateCheckboxMultiple,
    'dropdown': validateDropdown,
    'text-conjugation': validateTextConjugation,
    'text-dictation': validateTextConjugation
  };

  function validateAnswers(answers, payload) {
    var errors = [];
    if (!Array.isArray(answers)) {
      return { valid: false, errors: ['answers must be an array'] };
    }
    var idx = indexExercises(payload);
    for (var i = 0; i < answers.length; i++) {
      var ans = answers[i];
      if (!ans || typeof ans !== 'object' || typeof ans.exerciseId !== 'string') {
        errors.push('answer #' + i + ': missing or invalid exerciseId');
        continue;
      }
      var ex = idx[ans.exerciseId];
      if (!ex) {
        errors.push('answer #' + i + ': unknown exerciseId "' + ans.exerciseId + '"');
        continue;
      }
      var fn = DISPATCH[ex.type];
      if (!fn) {
        // Types "mixed" / "unsupported" : skip silencieux (pas d'erreur)
        continue;
      }
      fn(ans, ex, errors);
    }
    if (errors.length === 0) return { valid: true };
    return { valid: false, errors: errors };
  }

  // ----- Exposition (UMD-like) -------------------------------------------
  var api = {
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildUserPrompt: buildUserPrompt,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    parseLLMResponse: parseLLMResponse,
    validateAnswers: validateAnswers
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.autoGymglishBase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
