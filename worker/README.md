# Worker Cloudflare — Carte mentale STUDCORP (Claude)

Ce dossier contient le service nécessaire à la synchronisation de la carte mentale entre plusieurs appareils. Il sert aussi de proxy sécurisé pour l'agent IA Claude : la clé Anthropic reste côté Cloudflare et n'est jamais placée dans le navigateur.

## Emplacement du dossier

Place le dossier `worker` à la racine du projet STUDCORP, au même niveau que `index.html`, `app.js`, `styles.css` et `data.js`.

## Prérequis

- Un compte Cloudflare vérifié.
- Node.js et npm installés sur l'ordinateur qui servira au déploiement.
- Le site STUDCORP déjà publié sur GitHub Pages.
- Une clé API Claude créée dans la Claude Console si tu souhaites activer l'agent IA. La synchronisation seule ne nécessite pas de clé Claude.

## Déployer ou redéployer le Worker

Ouvre un Terminal dans le dossier `worker`, puis exécute :

```bash
npm install
npx wrangler login
npx wrangler secret put ALLOWED_ORIGIN
```

Lorsque Wrangler demande la valeur de `ALLOWED_ORIGIN`, saisis uniquement l'origine GitHub Pages, sans chemin ni slash final. Pour `https://sopp24.github.io/Cocon-S-mantique-Studcorp/`, la valeur à saisir est :

```text
https://sopp24.github.io
```

Crée ensuite le sous-domaine `workers.dev` dans le tableau de bord Cloudflare si ce n'est pas déjà fait (Workers & Pages → ouvrir la configuration du sous-domaine workers.dev).

Déploie le Worker :

```bash
npx wrangler deploy
```

À la fin, copie l'URL publique du Worker, par exemple `https://studcorp-carte-mentale-ai.<ton-sous-domaine>.workers.dev`.

## Activer l'agent IA Claude (facultatif)

1. Crée une clé API dans la Claude Console : https://platform.claude.com/settings/keys
2. Dans le Terminal, toujours dans `worker`, exécute :

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

3. Colle ta clé Claude quand Wrangler la demande. Ne la mets jamais dans GitHub, `app.js`, `data.js` ou le navigateur.
4. Redéploie le Worker :

```bash
npx wrangler deploy
```

Le modèle par défaut du Worker est `claude-haiku-5-5`. Pour choisir explicitement un autre modèle, tu peux définir le secret facultatif `ANTHROPIC_MODEL` :

```bash
npx wrangler secret put ANTHROPIC_MODEL
```

Puis saisis l'identifiant exact du modèle souhaité, par exemple `claude-sonnet-5-5`, et redéploie.

## Connecter les appareils à la synchronisation

Sur chaque appareil :

1. Ouvre l'application STUDCORP.
2. Va dans **Agent IA → ⚙**.
3. Dans **Worker partagé pour la synchronisation multi-appareils**, colle l'URL publique du Worker, sans `/api/state`.
4. Clique sur **Enregistrer**.

Tous les appareils utilisant cette même URL rejoignent la même carte. La sauvegarde locale du navigateur reste active en complément.

## Connecter l'agent IA Claude dans l'application

Dans les paramètres de l'agent IA :

- **Adresse API / URL de base** : URL du Worker suivie de `/v1`, par exemple `https://studcorp-carte-mentale-ai.<ton-sous-domaine>.workers.dev/v1`.
- **Modèle** : `claude-haiku-5-5`.
- **Clé API dans le navigateur** : laisser vide. La clé est conservée côté Cloudflare dans `ANTHROPIC_API_KEY`.
- **Worker partagé pour la synchronisation multi-appareils** : URL du Worker sans `/v1`.

Clique sur **Enregistrer**. Le Worker convertit le format de requête utilisé par l'application STUDCORP vers l'API Messages de Claude, puis adapte la réponse au format attendu par l'application.

## Notes

- La synchronisation multi-appareils fonctionne indépendamment de l'API Claude.
- La création d'une clé API Claude est gratuite, mais les appels API nécessitent des crédits d'utilisation. Consulte les tarifs et le solde dans la Claude Console.
- Après toute modification de `worker.js` ou `wrangler.toml`, redéploie avec `npx wrangler deploy`.
