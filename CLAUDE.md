# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

Extension Chrome (Manifest V3) qui détecte les exercices Gymglish dans le DOM, les envoie à un LLM (Gemini / Claude / Ollama local au choix), puis remplit automatiquement les champs. La soumission de la leçon reste manuelle.

Cible plateforme : tous les produits A9 (Gymglish, Frantastique, Wunderbla, Hotel Borbollón, Saga) — ils partagent la même structure DOM.

## Architecture cible

```
src/
├── content/        # injecté dans la page leçon
│   ├── parser.js     # extraction exos depuis le DOM (4 types)
│   ├── filler.js     # remplit DOM + délais + sabotage cible
│   └── content.js    # orchestrateur, écoute msg du popup
├── background/
│   └── service-worker.js   # routeur LLM, ne touche jamais le DOM
├── providers/
│   ├── base.js       # interface solve(payload) → answers
│   ├── gemini.js
│   ├── claude.js
│   └── ollama.js
└── popup/
    ├── popup.html / .css / .js   # UI principale
    └── settings.js               # gestion config
```

**Flux de données** :
1. Content script parse le DOM → JSON exercices
2. Popup déclenche "Solve" → message au background
3. Background appelle le provider LLM choisi → reçoit JSON réponses
4. Content fill les champs avec délais + sabotage selon `target_accuracy`
5. Utilisateur clique "Envoyer la leçon" lui-même

## Détection des exercices Gymglish

**4 types d'inputs identifiés** (préfixes `name=` stables sur toute la plateforme A9) :

| Pattern DOM | Type schéma | Sémantique |
|---|---|---|
| `<input type="radio" name="radioqcm\d+">` | `radio-single` | QCM choix unique |
| `<input type="checkbox" name="QCMC\d+">` value="checked" | `checkbox-multiple` | "Toutes les vraies" |
| `<select name="BRAF\d+">` avec options `BRAC\d+` | `dropdown` | Trous à choix limité |
| `<input type="text" name="BRAM\d+" placeholder="...">` | `text-conjugation` | Trous libres (placeholder = consigne, ex. "to steal") |

**Frontière review/actif** : `.section-revision` contient les corrigés des leçons précédentes (réponses visibles dans `class="correct"` / `a9c-choice-good` / `class="autotest-answer"`, inputs `disabled="disabled"`). À **exclure** du parsing.

**Bloc TST = unité d'exercice** : repérable via `[data-guapo-xml-qs*="xml-id=TST..."]` ou commentaire HTML `<!-- TST\d+ -->`.

**Contexte dialogue** : `.section-story` contient le dialogue complet en clair dans le DOM dès le chargement. À envoyer au LLM comme contexte pour les exos qui s'y réfèrent (compréhension, conjugaison contextuelle).

**Type inconnu rencontré** : marquer `unsupported` dans le JSON + log `outerHTML.slice(0,500)` en console (ne pas crasher le parsing).

## Schéma JSON LLM

Payload envoyé au LLM :
```json
{
  "context": "dialogue complet",
  "exercises": [
    {"id":"TST151822","type":"checkbox-multiple","statement":"...","choices":[{"id":"QCMC...","text":"..."}]},
    {"id":"TST151825","type":"text-conjugation","statement":"... [BLANK_BRAM176859] ...","blanks":[{"id":"BRAM176859","verb":"to steal"}]}
  ]
}
```

Réponse attendue :
```json
{"answers":[
  {"exerciseId":"TST151822","selected":["QCMC549274","QCMC549276"]},
  {"exerciseId":"TST151825","blanks":{"BRAM176859":"stole"}}
]}
```

## Décisions de spec actées

- **Sabotage de réponses** : LLM répond toujours 100% correct, le sabotage se fait côté JS selon `target_accuracy` (slider popup). Mix : remplacer par autre choix plausible OU sélectionner "Je ne sais pas".
- **Timing** : délais 0.5-2s entre chaque fill. Bouton "Skip wait" disponible dans le popup.
- **Submit** : jamais automatique. L'utilisateur clique "Envoyer la leçon" à la main.
- **Audio/dictée** : skip silencieux, comptabilisés dans le popup ("X exos audio ignorés").
- **Stockage** : `chrome.storage.local` pour clés API et préférences.
- **Configurabilité** : Ollama URL et modèle paramétrables (l'extension sera utilisée par d'autres personnes que l'auteur).
- **Dispatch d'événements** : après chaque fill, dispatcher `input`/`change`/`blur` — sinon Gymglish ne valide pas la réponse côté framework.

## Roadmap (phasée, livrables testables)

1. **Phase 0** : setup repo + manifest MV3 + icônes placeholder
2. **Phase 1** : parser pur avec popup "Detect & Log" (testé sur 3-4 leçons réelles avant de continuer)
3. **Phase 2** : routeur LLM (3 providers)
4. **Phase 3** : filler avec délais et sabotage
5. **Phase 4** : UI popup + settings complets
6. **Phase 5** : robustesse multi-leçons + logging
7. **Phase 6** : polish optionnel (preview, stats, drag&drop si rencontré)

Phase 1 est validée seule avant d'écrire la moindre ligne de Phase 2+ : le JSON renvoyé doit être correct sur plusieurs leçons.

## Référence DOM

Fichier exemple complet d'une leçon Gymglish disponible dans `~/Téléchargements/view-source_https___www.gymglish.com_gymglish_workbook_show-lesson_182747925_L.html` (892 lignes, leçon "Perfume California — The Great Ape Escape"). Contient les 4 types d'inputs et les sections review/story/test typiques.

## Chargement extension dev

```
chrome://extensions → Mode développeur → Charger l'extension non empaquetée → sélectionner le dossier racine du projet
```

Pour Firefox/Brave équivalents (MV3 supporté).

## Aspects légaux

L'utilisation viole les TOS Gymglish ("ne pas interférer avec le fonctionnement"). Sanction prévue par les TOS : avertissement 7 jours puis résiliation. Aucun ban automatique connu publiquement. Le sabotage configurable et la soumission manuelle servent aussi à réduire la détectabilité, pas seulement le réalisme pédagogique.
