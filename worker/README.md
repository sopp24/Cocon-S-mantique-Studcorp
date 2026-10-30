# Worker Cloudflare — Carte mentale STUDCORP + Google Gemini

Ce Worker assure deux fonctions :
- la synchronisation de la carte mentale entre les appareils via un Durable Object SQLite ;
- le relais sécurisé des demandes de l'agent IA vers Google Gemini. La clé Gemini reste dans les secrets Cloudflare.

## Prérequis

- Le site STUDCORP publié sur GitHub Pages.
- Node.js et npm installés sur le Mac.
- Un compte Cloudflare avec un sous-domaine `workers.dev` activé.
- Une clé API Gemini créée dans Google AI Studio.

## Installation initiale

Ouvre le Terminal dans ce dossier `worker`, puis exécute :

```bash
npm install
npx wrangler login
```

Si `ALLOWED_ORIGIN` a déjà été enregistré pour ce Worker, ne le recrée pas. Sinon :

```bash
npx wrangler secret put ALLOWED_ORIGIN
```

À la demande de Wrangler, indique uniquement l'origine GitHub Pages, sans chemin ni slash final. Pour le site STUDCORP actuel, la valeur est :

```text
https://sopp24.github.io
```

## Ajouter la clé Gemini (gratuite dans les limites du niveau Free)

Crée une clé sur https://aistudio.google.com/app/apikey, puis enregistre-la dans Cloudflare :

```bash
npx wrangler secret put GEMINI_API_KEY
```

Colle la clé lorsque Wrangler la demande. Ne la mets jamais dans GitHub, dans `app.js`, dans `data.js` ou dans le navigateur.

Le Worker utilise par défaut le modèle `gemini-3.8-flash`. Tu peux laisser le modèle par défaut. Pour le fixer explicitement côté serveur :

```bash
npx wrangler secret put GEMINI_MODEL
```

Puis saisis :

```text
gemini-3.8-flash
```

## Publier le Worker

```bash
npx wrangler deploy
```

À la fin, Wrangler affiche l'adresse du Worker, de la forme `https://studcorp-carte-mentale-ai.<sous-domaine>.workers.dev`. Garde cette adresse.

## Configurer le site STUDCORP

Dans l'application, ouvre **Agent IA → ⚙** :

1. **Worker partagé pour la synchronisation multi-appareils** : colle l'adresse de base du Worker, sans chemin.
2. **URL de l'API ou du proxy sécurisé** : colle la même adresse suivie de `/v1`.
3. **Modèle** : `gemini-3.8-flash`.
4. **Clé API** : laisse le champ vide (la clé est gardée côté Cloudflare).
5. Clique sur **Enregistrer**.

Exemple avec une adresse fictive :

```text
Worker partagé : https://studcorp-carte-mentale-ai.exemple.workers.dev
URL API        : https://studcorp-carte-mentale-ai.exemple.workers.dev/v1
Modèle         : gemini-3.8-flash
Clé API        : (vide)
```

Sur chaque autre appareil, renseigne la même adresse de Worker dans les paramètres de l'application.

## Important : rester à 0 €

Google affiche actuellement le modèle Gemini 3.8 Flash dans son niveau d'utilisation gratuit, avec des quotas/rate limits. Pour éviter toute facturation Google, ne relie pas de compte de facturation payant au projet Google AI Studio / Google Cloud utilisé pour cette clé. Une fois les quotas gratuits atteints, les requêtes peuvent être refusées jusqu'à leur réinitialisation. Les quotas peuvent évoluer.

Le niveau gratuit peut autoriser l'utilisation des données transmises pour améliorer les produits Google. Ne transmets pas de données confidentielles ou personnelles dans les prompts.

Cloudflare Workers Free a également ses propres limites quotidiennes. Le Worker ne configure pas de facturation Google ou Cloudflare à ta place.

## Après toute modification du Worker

Depuis ce dossier `worker`, republie le serveur avec :

```bash
npx wrangler deploy
```

La synchronisation `/api/state` et le stockage Durable Object sont conservés : cette mise à jour ne demande pas de recréer le Worker ni de modifier les données de la carte.
