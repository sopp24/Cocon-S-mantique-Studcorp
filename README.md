# Carte mentale éditoriale STUDCORP

Application web statique et responsive créée à partir de `Tableau blanc.pdf` et `Structuration_blog_STUDCORP.xlsx`.

## Fichiers

- `index.html` : page de l’application.
- `styles.css` : interface responsive et direction artistique.
- `app.js` : édition, recherche, sauvegarde, export/import et agent IA.
- `data.js` : données de départ reconstruites à partir des fichiers sources.
- `.nojekyll` : évite le traitement Jekyll de GitHub Pages.

## Ouvrir l’application

Le site ne nécessite ni installation ni compilation : ouvre `index.html` dans un navigateur récent. Pour un usage durable, recommande GitHub Pages (voir ci-dessous). Les fonctions principales sont intégrées aux fichiers, sans dépendance à un framework externe.

## Publier sur GitHub Pages

1. Crée un dépôt GitHub, par exemple `studcorp-carte-mentale`.
2. Dépose **tous** les fichiers de ce dossier à la racine du dépôt : `index.html`, `styles.css`, `app.js`, `data.js`, `.nojekyll` et `README.md`.
3. Dans le dépôt, ouvre **Settings → Pages**.
4. Dans la partie de publication, choisis **Deploy from a branch**, puis `main` et `/ (root)`, et enregistre.
5. Ouvre l’URL Pages donnée par GitHub. Configure ensuite le Worker partagé ci-dessous pour synchroniser les données entre appareils.

## Sauvegarde et synchronisation multi-appareils

- La sauvegarde locale continue de fonctionner dans le navigateur.
- Pour que la carte soit partagée entre tous les appareils, déploie le Worker Cloudflare inclus dans `worker/`. Le stockage partagé repose sur un Durable Object SQLite versionné ; les appareils chargent l’état distant à l’ouverture et vérifient les mises à jour automatiquement.
- Dans `worker/`, exécute `npx wrangler login`, puis `npx wrangler secret put ALLOWED_ORIGIN` et colle l’origine exacte du site GitHub Pages (par exemple `https://TON-COMPTE.github.io`). Si tu utilises aussi l’agent IA, définis `OPENAI_API_KEY` avec `npx wrangler secret put OPENAI_API_KEY`. Termine avec `npx wrangler deploy`.
- Sur **chaque appareil**, ouvre l’application, puis **Agent IA → ⚙** et renseigne l’adresse de base du Worker dans **Worker partagé pour la synchronisation multi-appareils**, sans ajouter `/api/state`. Clique sur **Enregistrer** une fois par appareil. Tous les appareils qui utilisent cette même URL rejoignent la même carte.
- Les mises à jour sont vérifiées toutes les cinq secondes. En cas de modifications simultanées, l’application compare les versions et fusionne les changements distincts ; en cas de conflit sur un même champ, elle conserve la valeur locale de l’appareil qui synchronise, puis transmet la fusion.
- **Exporter** et **Importer** restent disponibles pour les sauvegardes manuelles. Le bouton-logo STUDCORP actualise la page.

## Agent IA

L’application inclut un panneau Agent IA avec une proposition prévisualisée : **aucune modification n’est appliquée avant le clic sur « Accepter & appliquer »**. Tu peux refuser une proposition ou écrire une demande de modification pour la faire réviser. Les boutons **↶ Annuler** et **↷ Rétablir** permettent de naviguer dans l’historique des modifications. Dans la fiche de chaque article, la requête cible, le volume de recherche et la position SERP sont éditables manuellement.

Sans clé API ni proxy, un mode local permet de préparer quelques opérations simples (par exemple, créer une section) et indique ses limites. Pour une conversation libre et une organisation éditoriale plus avancée, le dossier `worker/` contient un proxy Cloudflare Workers qui garde la clé API côté serveur :

1. Déploie le site sur GitHub Pages et note son origine, par exemple `https://TON-COMPTE.github.io`.
2. Dans le dossier `worker/`, déploie le proxy avec Cloudflare Wrangler : `npx wrangler login`, puis `npx wrangler secret put OPENAI_API_KEY`, `npx wrangler secret put ALLOWED_ORIGIN` (colle l’origine GitHub Pages exacte) et enfin `npx wrangler deploy`. `OPENAI_MODEL` peut être défini en secret si tu souhaites imposer un modèle côté proxy.
3. Dans **Agent IA → ⚙**, renseigne l’adresse du Worker suivie de `/v1` (ex. `https://TON-WORKER.workers.dev/v1`), choisis le modèle et laisse le champ de clé API vide.
4. Clique sur **Enregistrer**. Le mode « Proxy IA configuré » s’affiche, puis tu peux faire tes demandes.

Le proxy vérifie l’origine autorisée, n’accepte que les requêtes de complétion prévues, limite la taille de la requête et garde la clé côté Worker. Comme toute API accessible sur Internet, ajoute une règle de limitation de débit dans Cloudflare pour éviter les usages abusifs. La restriction CORS ne remplace pas une limitation de débit.

**Évite de saisir une clé OpenAI dans le navigateur d’un site hébergé publiquement.** Le champ de clé directe reste utile pour des tests personnels, mais le fournisseur recommande de ne jamais déployer une clé dans un environnement côté client ; le proxy sécurisé est la méthode conseillée : https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety. Ne colle jamais de clé dans `app.js`, `data.js` ou GitHub.

## Données intégrées

Le modèle de départ reprend les **81 lignes de contenu** du tableur, avec les regroupements « Requêtes cibles ». La date, la rubrique actuelle, la cible, l’URL et les remarques sont conservées dans la fiche de chaque étiquette. Les mots-clés et volumes déjà présents sur le tableau blanc sont également ajoutés aux branches existantes. La légende reprend ses six libellés et couleurs de base (« Thématique », « Grande recherche », « Volume de recherche », les deux entrées « Requête cible » et « Page »). Deux étiquettes orange vides sur le PDF sont conservées comme emplacements « Requête cible à renseigner » pour ne pas inventer leur contenu. Les volumes sont recopiés tels qu’affichés dans le document source, sans actualisation externe.
