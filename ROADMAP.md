# Roadmap autoGymglish

## Phase 0 — Setup (30 min)
- [ ] Init repo `~/github/autoGymglish/` avec `git init`
- [ ] `manifest.json` MV3 minimal (host_permissions: `*.gymglish.com/*`, `*.frantastique.com/*`, `*.wunderbla.com/*`, `*.hotelborbollon.com/*`, `*.saga-italian.com/*`)
- [ ] Structure dossiers (`src/content`, `src/background`, `src/popup`, `src/providers`, `icons`)
- [ ] Icônes placeholder (SVG simple → 16/48/128 px)
- [ ] README avec instructions chargement extension dev

## Phase 1 — Parser pur (livrable testable)
- [ ] `parser.js` : détecte les 4 types d'inputs (`radioqcm`, `QCMC checkbox`, `BRAF select`, `BRAM text`)
- [ ] Extraction énoncé par bloc TST (clone + remplacement inputs par `[BLANK_xxx]`)
- [ ] Extraction dialogue/contexte de `.section-story`
- [ ] Détection frontière `.section-revision` → exclusion review
- [ ] Détection audio/dictée → marquer `skipped`
- [ ] Type inconnu → marquer `unsupported` + log outerHTML
- [ ] `content.js` : message handler "PARSE" → renvoie JSON
- [ ] Popup minimal : bouton "Detect & Log" → console
- [ ] **Test sur 3-4 leçons différentes** (validation manuelle des JSON avant Phase 2)

## Phase 2 — Provider LLM
- [ ] `providers/base.js` : interface unifiée `solve(payload) → answers`
- [ ] `providers/gemini.js` (Generative Language API, modèle config)
- [ ] `providers/claude.js` (Messages API)
- [ ] `providers/ollama.js` (POST `/api/chat`, URL + modèle config)
- [ ] Prompt système commun + JSON schema strict
- [ ] `service-worker.js` : routage selon provider sélectionné
- [ ] Gestion erreurs (clé invalide, modèle indispo, timeout)

## Phase 3 — Filler
- [ ] `filler.js` : applique réponses LLM au DOM
- [ ] Dispatch `input`/`change`/`blur` events (sinon Gymglish ignore)
- [ ] Délais aléatoires 0.5-2s entre champs
- [ ] Bouton "Skip wait" dans popup
- [ ] Sabotage côté JS : selon `target_accuracy`, gâche N réponses
  - Mix : choix plausible alternatif OU "Je ne sais pas"
- [ ] Pas de submit auto

## Phase 4 — UI complète
- [ ] Popup design propre :
  - Status (X exos détectés, Y audio skippés)
  - Slider "Target accuracy: 100%" (default) → 50%
  - Selector provider (Gemini / Claude / Ollama)
  - Bouton "Solve"
  - Indicateur progression filling
- [ ] Page settings (séparée ou dans popup) :
  - Champs clés API (Gemini, Claude)
  - Champ Ollama URL + modèle
  - Choix modèle pour Gemini/Claude
  - Toggle "Enable audio attempts"
- [ ] Stockage `chrome.storage.local` pour clés + prefs
- [ ] Badge icône : ✓ vert si exos détectés, ✕ gris sinon

## Phase 5 — Robustesse
- [ ] Test sur 5+ leçons réelles (différents produits si possible)
- [ ] Gérer cas edge : leçon vide, page non-leçon, exos déjà soumis
- [ ] Logging activable (console verbose pour debug)
- [ ] Validation JSON LLM (schéma strict, retry 1× si parsing fail)

## Phase 6 — Polish (optionnel)
- [ ] Mode preview : afficher réponses LLM avant fill, bouton confirm
- [ ] Stats locales : leçons faites, taux accuracy moyen
- [ ] Support drag&drop si rencontré
- [ ] i18n popup (fr/en)
- [ ] Packaging `.zip` pour partage hors Chrome Web Store

---

## Livrables intermédiaires

| Phase | État testable |
|---|---|
| 1 | Parser seul, JSON loggé en console |
| 2 + 3 | Solver fonctionnel basique end-to-end |
| 4 | Produit présentable avec UI complète |
| 5 + 6 | Robuste pour partage à d'autres utilisateurs |

## Estimation grosse maille

- Phase 0+1 : 1 session
- Phase 2+3 : 1 session
- Phase 4 : 1 session
- Phase 5+6 : 1 session

## Gate de validation Phase 1 → Phase 2

Avant d'écrire Phase 2, le parser doit produire un JSON correct sur **au moins 3 leçons réelles différentes**. Inclure si possible :
- Une leçon Gymglish standard
- Une leçon avec section story + audio
- Une leçon d'un autre produit A9 (Frantastique / Wunderbla) si compte disponible
