# autoGymglish

Extension Chrome (Manifest V3) qui détecte les exercices Gymglish dans le DOM, les fait résoudre par un LLM (Gemini / Claude / Ollama au choix), puis remplit automatiquement les champs.

La **soumission de la leçon reste manuelle** : l'extension ne clique jamais "Envoyer".

Compatible avec tous les produits A9 (même structure DOM) :

- Gymglish (anglais)
- Frantastique (français)
- Wunderbla (allemand)
- Hotel Borbollón (espagnol)
- Saga (italien)

## Fonctionnalités

- 5 types d'exercices supportés : QCM (radio + checkbox), trous à choix limité (dropdowns), trous libres (conjugaison), **dictées audio**
- 3 providers LLM au choix : **Google Gemini**, **Anthropic Claude**, **Ollama** (local)
- **Audio fallback automatique** : si une clé Gemini est configurée, les dictées audio sont routées vers Gemini même si le provider actif est Claude ou Ollama (qui ne supportent pas l'audio)
- **Slider "target accuracy"** 0–100 % — l'extension sabote volontairement N % des réponses pour simuler des erreurs réalistes (typo, mauvais mot du wordBank, choix alternatif, ou case "Je ne sais pas")
- Délais randomisés 0,5–2 s entre chaque remplissage, avec bouton **Skip wait**
- Bouton **Stop** pour interrompre proprement
- UI dark mode auto

## Installation (mode développeur)

1. Cloner le dépôt :
   ```bash
   git clone https://github.com/<TON_USER>/autoGymglish.git
   cd autoGymglish
   ```
2. Ouvrir `chrome://extensions` (Chrome, Brave, Edge, ou autre Chromium MV3).
3. Activer **Mode développeur** (interrupteur en haut à droite).
4. **Charger l'extension non empaquetée** → sélectionner le dossier racine du dépôt.
5. Épingler l'icône à la barre d'extensions pour l'avoir sous la main.

Pour mettre à jour : `git pull` puis recharger l'extension via la flèche circulaire dans `chrome://extensions`.

## Configuration

1. Cliquer sur l'icône → **⚙ Settings**.
2. Choisir le provider actif (Gemini / Claude / Ollama).
3. Renseigner la clé API ou l'URL Ollama.
4. **Save settings**.

> 💡 **Astuce dictées audio** : Claude et Ollama ne gèrent pas l'audio. Si tu utilises l'un des deux comme provider principal, configure aussi une clé Gemini — les dictées audio seront routées vers Gemini automatiquement. Le statut s'affiche dans Settings sur les cartes Claude / Ollama.

### Obtenir une clé API

| Provider | URL | Coût |
|---|---|---|
| Gemini | <https://aistudio.google.com/apikey> | Tier gratuit généreux |
| Claude | <https://console.anthropic.com/settings/keys> | Payant à l'usage |
| Ollama | local, voir ci-dessous | 100 % gratuit |

### Ollama (option locale, gratuite)

```bash
# Installer
curl -fsSL https://ollama.com/install.sh | sh

# Lancer le service
ollama serve

# Récupérer un modèle (le plus petit qui fonctionne bien)
ollama pull qwen3:8b
```

⚠ Pour autoriser l'extension à appeler Ollama depuis le navigateur, il faut activer CORS. Via `sudo systemctl edit ollama.service` :

```ini
[Service]
Environment="OLLAMA_ORIGINS=*"
```

Puis :

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

## Utilisation

1. Ouvrir une leçon Gymglish (page commençant par `/workbook/show-lesson/...`).
2. Cliquer sur l'icône autoGymglish.
3. Régler le slider **Target accuracy** (100 % = parfait, 60 % = une erreur sur trois, etc.).
4. Cliquer sur **Solve & Fill**.
5. Attendre que les réponses s'affichent (5 s à plusieurs minutes selon le provider).
6. **Vérifier** les réponses puis cliquer manuellement sur **Envoyer la leçon** dans Gymglish.

### Boutons annexes

- **Scan page → console** : log le JSON des exercices détectés (debug du parser).
- **Solve · dry-run** : envoie au LLM mais ne touche **pas** au DOM (debug du provider).
- **Skip wait** : passe immédiatement à la réponse suivante pendant un fill.
- **Stop** : interrompt le fill en cours.

## Architecture

```
src/
├── content/         # injecté dans la page Gymglish
│   ├── parser.js     # extraction des exercices depuis le DOM
│   ├── filler.js     # remplit le DOM, dispatch des events, sabotage
│   └── content.js    # orchestrateur, écoute les messages du popup
├── background/
│   └── service-worker.js   # routeur LLM
├── providers/        # un fichier par provider, interface commune
│   ├── base.js
│   ├── gemini.js
│   ├── claude.js
│   └── ollama.js
└── popup/            # UI utilisateur
    ├── popup.html / .css / .js
    └── settings.html / .css / .js
```

Voir `CLAUDE.md` pour les détails de spec et `ROADMAP.md` pour l'avancement.

## Vie privée

- Toutes les clés API sont stockées dans `chrome.storage.local` (jamais transmises ailleurs que vers le provider choisi).
- Aucune télémétrie, aucun tracking.
- Le contenu des leçons est envoyé uniquement au provider LLM que tu sélectionnes.

## Disclaimer

L'usage de cette extension **viole les CGU de Gymglish** ("ne pas interférer avec le fonctionnement du service"). Sanction prévue : avertissement 7 jours puis résiliation. Aucun ban automatique connu publiquement.

Le sabotage configurable et la soumission manuelle servent à la fois la pédagogie (apprendre de ses erreurs) et la discrétion (ne pas avoir un score parfait suspect).

**Tu utilises cet outil à tes propres risques.**

## Licence

ISC.
