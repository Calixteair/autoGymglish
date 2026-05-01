/**
 * autoGymglish — parser.js
 *
 * Extrait les exercices d'une page Gymglish (et plus largement A9) depuis le DOM.
 * Expose : window.autoGymglishParser.parse() → { url, productLang, context, exercises, skipped, unsupported, stats }
 *
 * Vanilla JS, pas d'import. Chargé via content_scripts.
 * Code défensif : try/catch par bloc, ne plante jamais.
 */
(function () {
  'use strict';

  // ----- Constantes / regex -----------------------------------------------
  var TST_BLOCK_SELECTOR = '[data-guapo-xml-qs*="xml-id=TST"]';
  var STORY_TEXT_SELECTOR = '.section-story .story-text';
  var STORY_FALLBACK_SELECTOR = '.section-story';
  var DONT_KNOW_REGEX = /Je ne sais pas|I don'?t know|No lo s[eé]/i;

  // ----- Logger défensif --------------------------------------------------
  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[autoGymglish parser]');
      console.warn.apply(console, args);
    } catch (_) {}
  }

  // ----- Helpers DOM ------------------------------------------------------

  // Patterns de noms d'inputs Gymglish "exo" (pas les inputs internes type STOPMODULE/VERSION/IDONTKNOW).
  var EXO_INPUT_NAME_REGEX = /^(radioqcm|QCMC|BRAF|BRAM)\d+$/;

  /**
   * True si le bloc est en review (corrigé read-only).
   * On regarde s'il contient au moins un input "exo" actif (non disabled).
   * Si oui → c'est un vrai exo (même dans .section-revision : les "previous mistakes" sont à refaire).
   * Sinon → c'est juste un corrigé affiché.
   */
  function isReviewOnly(block) {
    if (!block || !block.querySelectorAll) return false;
    var inputs = block.querySelectorAll('input[name], select[name]');
    var hasActiveExoInput = false;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var name = el.getAttribute('name') || '';
      if (!EXO_INPUT_NAME_REGEX.test(name)) continue;
      if (!el.disabled) { hasActiveExoInput = true; break; }
    }
    return !hasActiveExoInput;
  }

  /** Extrait l'id TST depuis l'attribut data-guapo-xml-qs (ex "xml-id=TST151822"). */
  function extractTstId(node) {
    var raw = node.getAttribute('data-guapo-xml-qs') || '';
    var match = raw.match(/xml-id=(TST\d+)/);
    return match ? match[1] : null;
  }

  /** Sélecteur stable pour retrouver le bloc plus tard. */
  function buildSelector(tstId) {
    return '[data-guapo-xml-qs="xml-id=' + tstId + '"]';
  }

  /** Collapse les whitespaces et trim. */
  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Nettoie un texte qui contient des `\n` significatifs :
   * - chaque ligne est trimmée et ses espaces/tabs internes collapsés
   * - les lignes vides consécutives sont collapsées (max un saut entre lignes)
   * - le résultat global est trimmé.
   */
  function cleanMultilineText(s) {
    if (!s) return '';
    var lines = s.split('\n').map(function (l) {
      return l.replace(/[ \t\f\v\u00A0]+/g, ' ').trim();
    });
    // Filtrer les lignes vides multiples et trimmer aux extrémités
    var out = [];
    var blank = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line) {
        out.push(line);
        blank = false;
      } else if (!blank && out.length > 0) {
        out.push('');
        blank = true;
      }
    }
    // Trim final des lignes vides en queue
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  /**
   * Dans un clone DOM, remplace les <br> par des sauts de ligne textuels
   * et ajoute un `\n` après les blocs (p, div, li, h*).
   * Doit être appelé avant `textContent`.
   */
  function injectLineBreaks(root) {
    if (!root || !root.ownerDocument) return;
    var doc = root.ownerDocument;
    // 1) <br> → "\n"
    var brs = root.querySelectorAll('br');
    for (var i = 0; i < brs.length; i++) {
      var br = brs[i];
      if (br.parentNode) {
        br.parentNode.replaceChild(doc.createTextNode('\n'), br);
      }
    }
    // 2) Pour les blocs, append un "\n" en fin (avant fermeture)
    var blocks = root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr');
    for (var j = 0; j < blocks.length; j++) {
      blocks[j].appendChild(doc.createTextNode('\n'));
    }
  }

  /** Détermine la langue du produit depuis <html lang> ou body class. */
  function detectProductLang(doc) {
    var html = doc.querySelector('html');
    if (html && html.lang) return html.lang;
    var body = doc.body;
    if (body && body.className) {
      var m = body.className.match(/a9-lesson-source-lang-(\w+)/);
      if (m) return m[1];
    }
    return null;
  }

  // ----- Détection de type ------------------------------------------------

  /**
   * Inspecte les inputs présents dans un bloc TST et renvoie un descripteur :
   *   { types: Set<string>, inputs: { radios, checkboxes, selects, texts } }
   */
  function classifyBlock(block) {
    var radios = block.querySelectorAll('input[type="radio"][name^="radioqcm"]');
    var checkboxes = block.querySelectorAll('input[type="checkbox"][name^="QCMC"]');
    var selects = block.querySelectorAll('select[name^="BRAF"]');
    var texts = block.querySelectorAll('input[type="text"][name^="BRAM"]');

    var types = [];
    if (radios.length) types.push('radio-single');
    if (checkboxes.length) types.push('checkbox-multiple');
    if (selects.length) types.push('dropdown');
    if (texts.length) types.push('text-conjugation');

    return {
      types: types,
      inputs: { radios: radios, checkboxes: checkboxes, selects: selects, texts: texts }
    };
  }

  // ----- Détection audio --------------------------------------------------

  /**
   * Repère un exo qui dépend vraiment de l'audio (dictée, écoute).
   * Heuristique : titre/placeholder explicite, ou input texte sans énoncé écrit
   * avec un <audio> non-décoratif.
   */
  function isAudioExercise(block, statementText) {
    try {
      // Indice fort : un input dont le hint mentionne l'audio.
      var hintInputs = block.querySelectorAll('input[placeholder], input[title]');
      for (var i = 0; i < hintInputs.length; i++) {
        var ph = (hintInputs[i].getAttribute('placeholder') || '') + ' ' + (hintInputs[i].getAttribute('title') || '');
        if (/écoute|écris ce que tu entends|listen|dictation|dictée/i.test(ph)) {
          return true;
        }
      }
      // Bloc presque vide en texte mais qui contient un <audio> "principal"
      // (pas un audio de prononciation décoratif via .inner-media)
      var audios = block.querySelectorAll('audio');
      var hasMainAudio = false;
      for (var j = 0; j < audios.length; j++) {
        var a = audios[j];
        if (!a.closest('.inner-media') && !a.closest('.pronunciation-players')) {
          hasMainAudio = true;
          break;
        }
      }
      if (hasMainAudio && cleanText(statementText).length < 20) return true;
    } catch (_) {}
    return false;
  }

  // ----- Énoncé propre ----------------------------------------------------

  /**
   * Clone le bloc, remplace inputs/selects par [BLANK_<name>], retire scripts,
   * audios, boutons, et options "Je ne sais pas". Retourne le textContent nettoyé.
   */
  function buildStatement(block) {
    var clone = block.cloneNode(true);

    // Retirer les éléments parasites
    var toRemove = clone.querySelectorAll('script, audio, video, button, .pronunciation-players, .a9-btn-selfrequest-container, .video-container');
    for (var i = 0; i < toRemove.length; i++) {
      toRemove[i].parentNode && toRemove[i].parentNode.removeChild(toRemove[i]);
    }

    // Retirer les blocs "Je ne sais pas" autonomes
    var idkBlocks = clone.querySelectorAll('.idontknow, .idontknow-mod, .a9c-choice-idontknow, .dontknowchoice');
    for (var k = 0; k < idkBlocks.length; k++) {
      // pour dontknowchoice on ne retire que si c'est sur un span de label / choix
      var el = idkBlocks[k];
      if (el && el.parentNode) {
        // un dontknowchoice peut être dans un <option> : ne pas retirer là
        if (el.tagName === 'OPTION') continue;
        el.parentNode.removeChild(el);
      }
    }

    // Remplacer chaque input/select par un placeholder
    var fields = clone.querySelectorAll('input, select, textarea');
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var name = field.getAttribute('name');
      if (!name) continue;
      // On ignore les champs hidden et les checkboxes "STOPMODULE-..." ou "USERVOCREQUEST-..."
      if (/^(STOPMODULE|USERVOCREQUEST|VERSION|MODULE|EPISODE_RATING|SENDBUTTON|IDONTKNOW|THEME)/.test(name)) {
        if (field.parentNode) field.parentNode.removeChild(field);
        continue;
      }
      var marker = clone.ownerDocument.createTextNode(' [BLANK_' + name + '] ');
      if (field.parentNode) field.parentNode.replaceChild(marker, field);
    }

    // Préserver les sauts de ligne sémantiques (br, fin de blocs)
    injectLineBreaks(clone);

    return cleanMultilineText(clone.textContent);
  }

  // ----- Choix QCM (radio + checkbox) ------------------------------------

  /** Trouve le label associé à un input radio/checkbox. */
  function findLabel(input) {
    var doc = input.ownerDocument;
    var id = input.getAttribute('id');
    if (id) {
      var lab = doc.querySelector('label[for="' + id + '"]');
      if (lab) return lab;
    }
    var parentLabel = input.closest && input.closest('label');
    if (parentLabel) return parentLabel;
    var sibling = input.nextElementSibling;
    if (sibling && sibling.tagName === 'LABEL') return sibling;
    return null;
  }

  /** Indique si un input/label est l'option "Je ne sais pas". */
  function isDontKnowChoice(input, label) {
    if (!label) return false;
    if (label.querySelector('.dontknowchoice')) return true;
    if (DONT_KNOW_REGEX.test(label.textContent || '')) return true;
    var wrapper = input.closest && input.closest('.a9c-choice-idontknow');
    if (wrapper) return true;
    return false;
  }

  /**
   * Construit la liste de choix pour un set d'inputs radio/checkbox.
   * - radio : l'identifiant du choix est `input.value` (= QCMC...)
   * - checkbox : `value="checked"` est partagé, on prend `input.name` (= QCMC...).
   */
  function extractChoices(inputs) {
    var choices = [];
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var label = findLabel(input);
      if (isDontKnowChoice(input, label)) continue;
      var text = cleanText(label ? label.textContent : '');
      var choiceId = input.type === 'checkbox'
        ? (input.getAttribute('name') || input.id || input.value)
        : (input.value || input.id || input.getAttribute('name'));
      choices.push({ id: choiceId, text: text });
    }
    return choices;
  }

  // ----- Dropdowns --------------------------------------------------------

  /** Pour chaque <select>, retourne { id, hint, options:[{id,text}] }. */
  function extractDropdowns(selects) {
    var out = [];
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      var options = [];
      for (var j = 0; j < sel.options.length; j++) {
        var opt = sel.options[j];
        var val = opt.value;
        if (val === 'NOTDONE' || val === '') continue;
        if (opt.classList && opt.classList.contains('dontknowchoice')) continue;
        if (DONT_KNOW_REGEX.test(opt.textContent || '')) continue;
        options.push({ id: val, text: cleanText(opt.textContent) });
      }
      out.push({ id: sel.getAttribute('name'), options: options });
    }
    return out;
  }

  // ----- Champs texte (conjugaison) ---------------------------------------

  /** Pour chaque input texte, renvoie { id, hint }. */
  function extractTextBlanks(texts) {
    var blanks = [];
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var hint = t.getAttribute('placeholder') || t.getAttribute('title') || '';
      // Gymglish utilise placeholder=" " (un espace) comme valeur "vide"
      blanks.push({ id: t.getAttribute('name'), hint: cleanText(hint) });
    }
    return blanks;
  }

  /**
   * Détecte une banque de mots dans un texte de la forme "mot | mot | mot".
   * Retourne un tableau de mots trim, ou null si rien trouvé.
   * Heuristique : >= 2 séparateurs `|` entre mots → on considère que c'est une wordBank.
   */
  function detectWordBank(text) {
    if (!text) return null;
    // On match au moins 2 séparateurs `|` entre des mots (donc 3 mots minimum).
    var match = text.match(/(\b[\w'-]+(?:\s*\|\s*[\w'-]+){1,})/);
    if (!match) return null;
    var raw = match[1];
    // S'assurer qu'il y a bien au moins un séparateur : split sur `|` doit donner >= 2 entrées.
    var parts = raw.split('|').map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length < 2) return null;
    return parts;
  }

  // ----- Construction de l'exercice par type -----------------------------

  /** Assemble l'objet exercice selon le type détecté. */
  function buildExercise(tstId, classification, block) {
    var statement = buildStatement(block);
    var domSelector = buildSelector(tstId);
    var inputs = classification.inputs;
    var types = classification.types;

    if (types.length === 0) {
      return {
        unsupported: true,
        exercise: {
          id: tstId,
          type: 'unsupported',
          statement: statement,
          domSelector: domSelector,
          debug: (block.outerHTML || '').slice(0, 500)
        }
      };
    }

    if (types.length > 1) {
      var mixedBlanks = extractTextBlanks(inputs.texts);
      var mixedExercise = {
        id: tstId,
        type: 'mixed',
        statement: statement,
        subTypes: types,
        choices: extractChoices(inputs.radios.length ? inputs.radios : inputs.checkboxes),
        dropdowns: extractDropdowns(inputs.selects),
        blanks: mixedBlanks,
        domSelector: domSelector
      };
      attachWordBankIfNeeded(mixedExercise, mixedBlanks, statement);
      return { exercise: mixedExercise };
    }

    var type = types[0];
    var ex = { id: tstId, type: type, statement: statement, domSelector: domSelector };
    if (type === 'radio-single') {
      ex.choices = extractChoices(inputs.radios);
    } else if (type === 'checkbox-multiple') {
      ex.choices = extractChoices(inputs.checkboxes);
    } else if (type === 'dropdown') {
      ex.dropdowns = extractDropdowns(inputs.selects);
    } else if (type === 'text-conjugation') {
      ex.blanks = extractTextBlanks(inputs.texts);
      attachWordBankIfNeeded(ex, ex.blanks, statement);
    }
    return { exercise: ex };
  }

  /**
   * Si au moins un blank a un hint vide, tente de détecter une banque de mots
   * dans le statement, et l'attache à `exercise.wordBank`.
   * - Si trouvée  : ["should","would","could"]
   * - Sinon, et si tous les hints sont vides : `null` (le LLM se débrouille).
   * - Si tous les hints sont non vides : ne rien attacher.
   */
  function attachWordBankIfNeeded(exercise, blanks, statement) {
    if (!blanks || !blanks.length) return;
    var hasEmpty = false;
    for (var i = 0; i < blanks.length; i++) {
      if (!blanks[i].hint) { hasEmpty = true; break; }
    }
    if (!hasEmpty) return;
    var bank = detectWordBank(statement);
    exercise.wordBank = bank || null;
  }

  // ----- Contexte dialogue -----------------------------------------------

  /** Texte propre du dialogue (.section-story .story-text → fallback section). */
  function extractContext(doc) {
    var story = doc.querySelector(STORY_TEXT_SELECTOR);
    if (!story) story = doc.querySelector(STORY_FALLBACK_SELECTOR);
    if (!story) return null;
    var clone = story.cloneNode(true);
    var noise = clone.querySelectorAll('script, audio, video, button, input, .video-container, .a9-btn-selfrequest-container, .word-count, .scripttext-info');
    for (var i = 0; i < noise.length; i++) {
      noise[i].parentNode && noise[i].parentNode.removeChild(noise[i]);
    }
    var text = cleanText(clone.textContent);
    return text || null;
  }

  // ----- Boucle principale -----------------------------------------------

  /**
   * Itère sur tous les blocs TST de la page, exclut ceux en review,
   * et construit la liste exercises / skipped / unsupported.
   */
  function processBlocks(doc) {
    var blocks = doc.querySelectorAll(TST_BLOCK_SELECTOR);
    var exercises = [];
    var skipped = [];
    var unsupported = [];
    var totalActive = 0;

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      try {
        if (isReviewOnly(block)) continue;
        var tstId = extractTstId(block);
        if (!tstId) continue;
        totalActive++;

        var classification = classifyBlock(block);
        var statement = buildStatement(block);

        if (isAudioExercise(block, statement)) {
          skipped.push({ id: tstId, reason: 'audio' });
          continue;
        }

        var built = buildExercise(tstId, classification, block);
        if (built.unsupported) {
          unsupported.push({ id: built.exercise.id, debug: built.exercise.debug });
        }
        exercises.push(built.exercise);
      } catch (err) {
        warn('Erreur de parsing bloc TST', err);
      }
    }

    return { exercises: exercises, skipped: skipped, unsupported: unsupported, totalActive: totalActive };
  }

  // ----- Entry point ------------------------------------------------------

  /** API publique : parse(doc?) → JSON exercices. */
  function parse(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) {
      warn('Aucun document fourni');
      return null;
    }
    try {
      var allTst = doc.querySelectorAll(TST_BLOCK_SELECTOR);
      var processed = processBlocks(doc);
      var url = (typeof location !== 'undefined' && location.href) ||
                (doc.location && doc.location.href) || null;
      return {
        url: url,
        productLang: detectProductLang(doc),
        context: extractContext(doc),
        exercises: processed.exercises,
        skipped: processed.skipped,
        unsupported: processed.unsupported,
        stats: {
          total: allTst.length,
          active: processed.totalActive,
          skipped: processed.skipped.length,
          unsupported: processed.unsupported.length
        }
      };
    } catch (err) {
      warn('Échec global du parse', err);
      return null;
    }
  }

  // ----- Exposition globale ----------------------------------------------
  var api = {
    parse: parse,
    // Helpers exposés pour tests / extensions
    _internals: {
      classifyBlock: classifyBlock,
      buildStatement: buildStatement,
      extractChoices: extractChoices,
      extractDropdowns: extractDropdowns,
      extractTextBlanks: extractTextBlanks,
      extractContext: extractContext,
      isAudioExercise: isAudioExercise,
      isReviewOnly: isReviewOnly,
      cleanMultilineText: cleanMultilineText,
      injectLineBreaks: injectLineBreaks,
      detectWordBank: detectWordBank
    }
  };

  if (typeof window !== 'undefined') {
    window.autoGymglishParser = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
