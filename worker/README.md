# Worker Cloudflare — Carte mentale STUDCORP

Ce dossier contient le service nécessaire à la synchronisation de la carte mentale entre plusieurs appareils. Il peut également servir de proxy sécurisé pour l'agent IA.

## Emplacement du dossier

Place le dossier `worker` **à la racine du projet STUDCORP**, au même niveau que `index.html`, `app.js`, `styles.css` et `data.js`.

Arborescence attendue :

```text
studcorp-carte-mentale/
├── index.html
├── app.js
├── styles.css
├── data.js
├── README.md
└── worker/
    ├── worker.js
    ├── wrangler.toml
    ├── package.json
    ├── .gitignore
    └── README.md
```

Ne place pas le dossier `worker` à l'intérieur d'un autre dossier `worker`.

## Prérequis

- Un compte Cloudflare.
- Node.js et npm installés sur l'ordinateur qui servira au déploiement.
- Le site STUDCORP déjà publié sur GitHub Pages.

## Déployer le Worker pour la synchronisation

Ouvre un terminal **dans le dossier `worker`**. Par exemple, depuis la racine du projet :

```bash
cd worker
```

Installe Wrangler :

```bash
npm install
```

Connecte Wrangler au compte Cloudflare :

```bash
npx wrangler login
```

Ajoute l'origine autorisée de ton site GitHub Pages :

```bash
npx wrangler secret put ALLOWED_ORIGIN
```

Lorsque Wrangler demande la valeur, saisis uniquement l'origine du site, sans chemin ni slash final.

Exemple : si ton application est publiée à `https://mon-compte.github.io/studcorp-carte-mentale/`, entre :

```text
https://mon-compte.github.io
```

Puis déploie le Worker :

```bash
npx wrangler deploy
```

À la fin, Wrangler affiche l'URL publique du Worker. Copie cette URL.

## Connecter chaque appareil à la même carte

Sur chaque ordinateur, tablette ou téléphone :

1. Ouvre l'application STUDCORP.
2. Va dans **Agent IA → ⚙**.
3. Colle l'URL publique du Worker dans **Worker partagé pour la synchronisation multi-appareils**.
4. Ne rajoute pas `/api/state`.
5. Clique sur **Enregistrer**.

Tous les appareils configurés avec la même URL utilisent la même carte. Les changements sont recherchés automatiquement environ toutes les cinq secondes.

La sauvegarde locale du navigateur reste active en complément.

### Comportement en cas de modifications simultanées

Les changements effectués sur des champs différents sont fusionnés. Si deux appareils modifient exactement le même champ avant synchronisation, la valeur de l'appareil qui envoie la fusion est conservée. Pour éviter toute perte, évite de modifier simultanément la même étiquette sur plusieurs appareils.

## Activer aussi le proxy IA (facultatif)

Cette étape n'est pas nécessaire pour la synchronisation multi-appareils. Elle sert uniquement à faire fonctionner l'agent IA avec une clé conservée côté Cloudflare.

Ajoute la clé API OpenAI :

```bash
npx wrangler secret put OPENAI_API_KEY
```

Tu peux aussi définir le modèle utilisé par le proxy (facultatif) :

```bash
npx wrangler secret put OPENAI_MODEL
```

Saisis par exemple `gpt-4o-mini`.

Après le déploiement, dans les paramètres de l'agent IA, renseigne comme adresse API l'URL de ton Worker suivie de `/v1`, par exemple :

```text
https://nom-du-worker.nom-du-compte.workers.dev/v1
```

Laisse le champ de clé API du navigateur vide. Ne place jamais une clé API dans `app.js`, `data.js`, le dépôt GitHub ou un fichier public.

## Commandes pratiques

Toutes ces commandes se lancent depuis le dossier `worker` :

```bash
npm run dev       # lancer le Worker localement
npm run deploy    # déployer le Worker
npm run login     # connecter Wrangler à Cloudflare
```

Pour redéfinir les secrets, utilise les commandes `npx wrangler secret put ...` indiquées plus haut. Après une modification de `worker.js` ou `wrangler.toml`, redéploie avec `npx wrangler deploy`.
