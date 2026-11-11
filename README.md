# GOLSH — Application de dépôt-vente

Une seule application pour l’**iPhone**, l’**Android** et le **PC**. Toutes les fonctions sont disponibles partout : caisse, stock, dépôts, fournisseurs, marges, reversements, inventaire et réglages.

Elle est hébergée **gratuitement** sur Cloudflare (Workers + base D1 + KV pour les photos). Il n’y a ni serveur à gérer ni abonnement à payer.

---

## 🚀 Mise en ligne (une seule fois, ≈ 10 minutes, depuis un PC)

### Étape 1 — Mettre le code sur GitHub
1. Créez un compte gratuit sur **https://github.com**.
2. Cliquez sur **New repository**, nommez-le `golsh-depot`, choisissez **Public**, puis cliquez sur **Create repository**.
3. Sur la page du dépôt, cliquez sur **uploading an existing file**.
4. Décompressez le fichier zip, puis **glissez tout le contenu du dossier `golsh-depot`** dans la page : `src`, `public`, `test`, `wrangler.jsonc`, `package.json`…
5. Cliquez sur **Commit changes**.

### Étape 2 — Déployer en un clic
1. Ouvrez ce lien en remplaçant `VOTRE-COMPTE` par votre nom d’utilisateur GitHub :
   `https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-COMPTE/golsh-depot`
2. Créez un compte gratuit Cloudflare ou connectez-vous, puis reliez votre compte GitHub quand c’est demandé.
3. Laissez les noms proposés (base `golsh-depot-db` et espace photos), puis cliquez sur **Deploy**.
4. Après environ 1 minute, Cloudflare affiche votre adresse, par exemple `https://golsh-depot.votre-nom.workers.dev`.

> Cloudflare crée automatiquement une **copie du projet dans votre GitHub**. Les mises à jour se font ensuite sur cette copie, et le dépôt public de l’étape 1 peut être supprimé.
> La base de données est créée toute seule à la première ouverture.

### Étape 3 — Première ouverture sur l’iPhone de l’admin
1. Ouvrez l’adresse dans **Safari**. **Faites-le tout de suite** après le déploiement : le premier compte créé devient administrateur.
2. Créez le compte **administrateur** : nom, identifiant et mot de passe.
3. Touchez **Partager** ⬆️, choisissez **Sur l’écran d’accueil**, puis **Ajouter**.
4. L’application s’ouvre désormais en plein écran, comme une vraie app.

---

## 📱 Utilisation au quotidien

| Action | Où | Comment |
|---|---|---|
| **Recevoir un dépôt** | Onglet *Dépôt* | Choisir ou créer le fournisseur, ajouter les articles (prix, taille, marque, état, quantité), puis cliquer sur **Enregistrer** |
| **Étiqueter** | Après l’enregistrement du dépôt | **🖨 Étiquettes** : impression AirPrint depuis l’iPhone (planches A4 autocollantes 3×8, ou rouleau 50×30 mm) |
| **Faire signer** | Après l’enregistrement du dépôt | **📄 Bon de dépôt** à imprimer et signer, et **💬 WhatsApp** pour envoyer le récapitulatif au fournisseur |
| **Vendre** | Onglet *Caisse* (bouton ＋) | **Scanner** avec la caméra, ou douchette. Remise possible, choix du paiement, calcul de la monnaie à rendre |
| **Ticket client** | Après la vente | Impression, ou envoi par WhatsApp |
| **Prévenir le fournisseur** | Après la vente | Bouton WhatsApp pré-rempli : « votre article est vendu » |
| **Payer un fournisseur** | *Plus* › *Fournisseurs* › fiche | **Reverser** : solde calculé automatiquement, relevé PDF et envoi WhatsApp |
| **Rendre les invendus** | Fiche fournisseur | Cocher les articles (bouton *Expirés* pour tout sélectionner), puis **Rendre** |
| **Inventaire** | *Plus* › *Inventaire* | Scanner tout le rayon, puis **Comparer** : liste des manquants et des anomalies |
| **Retrouver un article** | Bouton **⌗ Scanner** en haut | On peut aussi viser le QR code avec l’**appareil photo de l’iPhone** : la fiche s’ouvre directement |

### Ce qui est automatique
- **Codes articles uniques** (GS000001, GS000002…) avec QR code et code-barres sur l’étiquette.
- **Démarque automatique**, par défaut −20 % après 30 jours et −40 % après 60 jours. La caisse applique le bon prix toute seule.
- **Commission** calculée selon cet ordre : taux de l’article › taux négocié avec le fournisseur › taux de la catégorie › palier de prix › taux par défaut (30 %). Le taux est **figé au moment de la vente**.
- **Solde de chaque fournisseur** tenu à jour en temps réel.
- **Alertes** : dépôts expirés à rendre (90 jours par défaut), articles invendus depuis plus de 30 jours, réservations.
- **Protection contre la double vente** : si deux téléphones scannent le même article, le second est refusé.
- **Brouillons conservés** : panier, dépôt en cours et comptage d’inventaire restent en mémoire, même si l’app est fermée.

### Rôles
- **Super admin** : tout ce que fait l’administrateur, plus la gestion des administrateurs, le **journal d’activité** (*Plus › Journal*) et la **remise à zéro** des données. Le premier compte créé est super admin.
- **Administrateur** : marges, reversements, réglages, exports. Il ne gère que les comptes caissiers.
- **Caissier** : vente, dépôts et inventaire. Il ne voit ni les marges ni les montants dus aux fournisseurs.

**Code de secours super admin (facultatif)** : dans Cloudflare › votre Worker › *Settings › Variables and Secrets*, ajoutez un secret `SUPERADMIN_CODE`. Un utilisateur connecté qui saisit ce code dans *Réglages › Mon compte* devient super admin.

### 📷 Photo intelligente au dépôt
Dans *Dépôt*, touchez **Photographier l’article**. L’IA de Cloudflare (Workers AI, 10 000 « neurons » gratuits par jour) pré-remplit la désignation, la catégorie, la marque et la taille lues sur l’étiquette, la couleur, l’état et un **prix suggéré**. Les champs remplis sont surlignés en jaune : vérifiez-les, puis ajoutez. La photo est enregistrée automatiquement sur l’article. Si l’IA est indisponible, la photo est gardée et on remplit à la main.

Pour créer des comptes caissier : *Réglages* › *Utilisateurs*.

---

## 🖨 Matériel conseillé (facultatif)
- **Étiquettes** : planches A4 autocollantes **3 × 8 (70 × 37 mm)** et n’importe quelle imprimante compatible **AirPrint**.
- **Douchette code-barres Bluetooth** en mode « clavier ». Elle se connecte à l’iPhone comme un clavier : scannez dans la case « Code article » de la caisse.
- Sans aucun matériel, la caméra de l’iPhone suffit.

---

## 🔒 Sauvegarde, sécurité, limites
- *Réglages* › *Exports & sauvegarde* : fichiers CSV (Excel/Numbers) et **sauvegarde complète** à télécharger chaque mois.
- Cloudflare D1 garde aussi un historique qui permet de restaurer la base à une date passée (fonction « Time Travel »).
- Les mots de passe sont chiffrés, la session dure 30 jours, et le compte est bloqué 15 minutes après 8 essais ratés.
- **Offre gratuite de Cloudflare** : 100 000 requêtes par jour et 5 Go de données. C’est largement suffisant pour une boutique, même avec des centaines de ventes par jour. Si l’activité grandit beaucoup, le plan payant coûte environ 5 $/mois et aucune modification n’est nécessaire.
- Une connexion internet est nécessaire pour vendre. Hors connexion, l’app s’ouvre mais affiche un bandeau d’avertissement.

## 🔄 Mettre à jour l’application
Modifiez un fichier dans le dépôt GitHub créé par Cloudflare. Chaque modification est redéployée automatiquement en 1 minute, et les données ne sont pas touchées.

---

## Pour les développeurs
```
src/worker.js        API (Cloudflare Worker, sans dépendance), schéma auto-créé
public/              Application PWA (HTML/CSS/JS sans framework, sans build)
public/vendor/       Générateur de QR code (MIT, K. Arase)
test/api.test.mjs    Tests de l’API : npm test (Node 22+)
test/dev-server.mjs  Serveur local sans Cloudflare : node test/dev-server.mjs
test/e2e.mjs         Test navigateur au format iPhone (Playwright)
```
Le scanner caméra utilise l’API native `BarcodeDetector` quand le navigateur la propose. Sinon (iPhone), il charge `html5-qrcode` depuis un CDN, puis le garde en cache.
