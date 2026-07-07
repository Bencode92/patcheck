# Brief technique — App « Patrimoine Famille » (focus AFFICHAGE)

> Document destiné à un designer / modèle IA (Claude Fable 5) pour **retravailler l'affichage / l'UX**.
> Il décrit précisément la stack, l'architecture, le modèle de données, le système de rendu, le thème,
> chaque écran, et les **pistes d'amélioration visuelle**. Objectif : améliorer la clarté et l'esthétique
> **sans casser** la logique métier ni les contraintes techniques.

---

## 1. Le produit en une phrase

App web **autonome** (une seule page, pas de framework, pas de build) qui aide une famille (2 parents + 3 enfants)
à **visualiser son patrimoine** et à **anticiper la transmission** : donations, abattements 15 ans, démembrement
(art. 669), assurance-vie (990 I / 757 B), pacte Dutreil, « si décès demain combien à payer », et un **conseiller IA**.

- En ligne : `https://bencode92.github.io/patcheck/` (GitHub Pages, repo **public** `Bencode92/patcheck`)
- Utilisateur : gestionnaire finance/trésorerie, **exigeant sur la clarté** et la lisibilité des chiffres.
- Référence esthétique de départ : sa page existante `stock-analysis-platform/successions-donations.html`
  (arbre familial, composants immo/entreprise/AV) — mais celle-ci est **déterministe**, sans IA.

---

## 2. Stack & contraintes techniques (À RESPECTER absolument)

| Contrainte | Détail |
|---|---|
| **Aucun build** | Vanilla JS **ES modules** chargés directement (`<script type="module">`). Pas de bundler, npm, JSX, TS. |
| **Aucune ressource externe** | Polices **système** uniquement, pas de CDN, pas de webfont, pas de lib CSS. Seule exception : **Mermaid.js** importé dynamiquement (organigramme). |
| **Self-contained** | Tout le CSS dans `src/styles.css`. Tout le JS dans `src/*.js`. |
| **Données privées** | Repo public → **jamais de données patrimoniales** commitées. Données en `localStorage` + KV Cloudflare privé. |
| **Cache-busting** | Tous les `<script>`/`<link>`/imports portent `?v=N`. **À chaque édition**, bumper N partout (index.html + imports). Sinon le navigateur sert l'ancienne version. |
| **Responsive** | Doit rester lisible sur mobile. Tables larges → scroll horizontal dans leur conteneur. |
| **Français** | Toute l'UI est en français. Montants formatés `fr-FR` (`123 456 €`, espace insécable, `€` suffixe). |

**Important pour un designer :** on peut **tout changer dans `styles.css`** et la structure HTML générée par les
fonctions `render*()`. On ne doit **pas** introduire de dépendance externe ni d'étape de build.

---

## 3. Architecture des fichiers

```
index.html          → coquille : <header>, #app, <footer>, charge styles.css + app.js
src/app.js  (1822 l) → CŒUR UI : state, onglets, toutes les fonctions render*(), event handlers
src/graph.js (385 l) → debrief(state) = moteur de calculs + buildMermaid(state) = organigramme
src/data.js  (125 l) → barèmes fiscaux figés 2026 + helpers (tauxUsufruit, calculDroits)
src/sync.js          → sauvegarde cloud (Worker Cloudflare + mot de passe)
src/ai.js            → askAI() : appel Claude Opus 4.8 via le Worker (onglet Conseil)
src/csv.js           → import/export CSV d'appoint
src/styles.css (655 l) → thème + tous les composants visuels
worker/patcheck-worker.js → Worker Cloudflare (stockage KV + proxy IA)
```

### Le pattern de rendu (à comprendre avant de toucher l'affichage)

- `state` = objet global en mémoire (chargé du localStorage/cloud).
- Un tableau `TABS = [{id, label}, …]` définit la barre d'onglets.
- Chaque onglet a une fonction `renderXxx()` qui fait **`$("#tab-content").innerHTML = \`… template string …\``**.
- Les interactions sont câblées **après** le `innerHTML`, par **délégation d'événements** (`el.addEventListener`,
  attributs `data-*`). Il n'y a **pas** de framework réactif : on **re-render** l'onglet entier après une modif,
  puis `save()` (localStorage + auto-save cloud débounce).
- Donc : **l'affichage = des template strings HTML dans app.js + les classes de styles.css**. C'est là qu'on travaille.

---

## 4. Modèle de données (`state`)

```js
state = {
  personnes: [ { id, nom, role:"parent"|"enfant", naissance:"1975-06-16"|null, annee:1975|null, ... } ],
  actifs:    [ { id, libelle, categorie, valeur, valeurMarchande?, prixAcquisition?, surface?,
                 dutreil?:bool, forme?, demembrementAnnee?:number } ],
  detentions:[ { proprietaire:<personneId|actifId(SCI)>, actifRef:<actifId>, part:<%>, droit:"PP"|"US"|"NP" } ],
  dettes:    [ { cible:<actifId|personneId>, montant, libelle } ],
  donations: [ { date:"AAAA-MM-JJ", donateurId, beneficiaireId, montant } ],
  av:        [ { id, libelle, etablissement, souscripteurId, cosouscripteurId?, montant,
                 avant70:bool, beneficiaires:[personneId], repartition:{personneId:%}, clause? } ],
  regime:    "" | "acquets" | "universelle" | "universelle_attribution" | "separation" | "participation",
  _ts:       <timestamp dernière modif, pour merge cloud>
}
```

**Catégories d'actifs** (`categorie`) : `immobilier`, `sci`, `entreprise`, `liquidites`, `titres`.
Chacune a une icône+label via `CAT_LOOKUP` (ex. `🏠 Immobilier`, `🏢 SCI`, `🏭 Entreprise`, `💰 Liquidités`, `📈 Titres`).

**Démembrement (art. 669)** : une détention peut être en US (usufruit) ou NP (nue-propriété). La valeur détenue
= `part% × valeur × fraction(669)`, où la fraction dépend de l'âge de l'usufruitier **figé à l'année du
démembrement** (`demembrementAnnee`). US + NP = valeur pleine (pas de double compte).

---

## 5. Le moteur `debrief(state)` — les données disponibles pour l'affichage

`graph.js → debrief(state)` retourne un objet riche que les écrans consomment. Champs clés :

| Champ | Sens |
|---|---|
| `patrimoineFoyer` | Patrimoine net des biens (valeur − dettes) |
| `patrimoineTaxable` | Assiette taxable succession après exonération Dutreil |
| `parCategorie` | `{immobilier: montant, sci: …}` → exposition par classe d'actif |
| `parPersonne` / `parPersonneDetail` | Total et **détail des biens détenus par chaque personne** (avec part, droit, fraction 669, usuAge) |
| `avAvant70` / `avApres70` | Capitaux d'assurance-vie par régime fiscal |
| `avBeneficiaires` | **Par bénéficiaire** : `{nom, capital, abattement(152 500), base, droits(990 I), net}` |
| `totalDroitsAV` | Total droits assurance-vie avant 70 ans |
| `apres70Reintegre` | Primes après 70 ans réintégrées (au-delà de 30 500 €) |
| `baseSuccessoraleGlobale` | patrimoineTaxable + AV après 70 réintégrée |
| `droitsSuccessionGlobaux` | Droits de succession sur la base globale |
| `totalDroitsTous` | **TOTAL des droits à payer** (succession globale + AV) |
| `successionParEnfant` | « Si décès demain » : `{nom, recu, abattement, base, droits, net, tauxEffectif}` par enfant |
| `scenarios` | 3 scénarios (`attribution`, `progressif`, `simultane`) → total droits enfants |
| `exonerationDutreil` | Montant exonéré via pacte Dutreil (−75 %) |
| `capaciteExoneree` | Capacité de donation encore en franchise d'impôt |
| `reco` | Liste de pistes détectées automatiquement (`{ico, text, action}`) → panneau « reste à faire » |
| `regime` | Régime matrimonial |

**→ Tout est déjà calculé.** Le travail d'affichage consiste à **mettre ces chiffres en scène** clairement.

---

## 6. Thème & composants CSS actuels

### Variables (`:root`)
Thème **clair, blanc & bleu, esprit fintech**. Extraits :
```
--bg:#f5f8fd  --panel:#fff  --panel-2:#f6f9fd  --line:#e3eaf5  --line-strong:#cfdcee
--txt:#10233f  --muted:#64748f
--accent:#1e63d6 (bleu)  --accent-2:#0b9f70 (vert)  --warn:#b56a00 (ambre)  --danger:#d92d20 (rouge)
--accent-soft:#e8f0fd  --radius:14px  --radius-sm:9px  --radius-lg:18px
--shadow-sm / --shadow-md  --ring (focus)  --tr (transition)
--font: system-ui…  --mono: ui-monospace…   /* font-variant-numeric: tabular-nums sur body */
```
Header : dégradé bleu (`linear-gradient(135deg,#1a63dd,#124bb4,#0e3f9c)`), texte blanc.

### Composants (classes disponibles)
| Classe | Usage |
|---|---|
| `.tabs` / `.tab` | Barre d'onglets |
| `.card` | Conteneur blanc arrondi ombré (bloc de section). `.card.hero` = bloc patrimoine total en avant |
| `.hero` / `.hero-total` | Gros chiffre patrimoine global |
| `.grid` (table) | Tableau de données (thead/tbody/tfoot) |
| `.result` + `.line` (+`.line.total`) | Liste clé→valeur alignée (ex. « Assiette taxable … 500 000 € ») |
| `.badge` (+`.warn`/`.ok`) | Étiquette (rôle, droit US/NP, « votre régime », « le moins coûteux ») |
| `.kpi` | Indicateur chiffré |
| `.asset-card`, `.asset-head`, `.asset-sub` | Fiche d'actif (onglet Patrimoine) |
| `.cat-group`, `.cat-header`, `.cat-body` | Groupe de catégorie repliable (onglet Patrimoine) |
| **`.perso-details`, `.perso-sum`, `.perso-body`** | **Toggle par personne** (Résumé → Qui possède quoi) — `<details>/<summary>` natif |
| **`.cat-details`, `.cat-sum`** | **Toggle par catégorie imbriqué** dans une personne |
| `.chat-box`, `.bubble` (`.user`/`.assistant`) | Chat IA (onglet Conseil) |
| `.chips`, `.chip` | Suggestions cliquables |
| `.reco`, `.reco-list`, `.reco-warn`, `.reco-ok`, `.reco-ico`, `.reco-info`, `.reco-action` | Panneau « reste à faire / optimisation » |
| `.gauge`, `.gauge-fill`, `.gauge-lbl` | Jauge (abattements consommés) |
| `.form-row`, `.benef-row`, `.benef-chk` | Formulaires de saisie |
| `.verif-btn` | Petit bouton « ✓ OK » de vérification par bien |
| `.mermaid-box` | Conteneur de l'organigramme Mermaid |
| `.btn` (+`.primary`/`.ghost`/`.danger`) | Boutons |
| `.muted`, `.small`, `.center` | Utilitaires texte |

Les toggles utilisent `<details>/<summary>` natifs, avec un chevron `▸` en `::before` qui pivote à l'ouverture.

---

## 7. Les écrans (onglets) — ce que chacun affiche

Ordre actuel de `TABS` :

1. **🏠 Résumé patrimonial** *(écran principal, le plus important pour l'affichage)*
   - **Hero** : patrimoine global (biens + AV).
   - **Organigramme Mermaid** (arbre famille + composants).
   - **👥 Qui possède quoi — détail par personne** : **toggles imbriqués** (personne → catégories repliables →
     lignes : bien, quote-part, droit PP/US/NP + fraction 669, valeur). + bloc assurance-vie par personne.
   - **Exposition par catégorie** (SCI regroupée avec immobilier, AV ajoutée comme classe).
   - **⚰️ Si décès aujourd'hui — droits par enfant** (table : part reçue, abattement, base, droits, net, taux).
   - **🛡️ Assurance-vie — ce que touche chaque bénéficiaire (990 I)** (table par bénéficiaire, après abattement).
   - **💰 Total des droits à payer & base successorale globale** (bloc `.result` de synthèse).
   - **⚖️ Scénarios de transmission** (attribution / progressif / simultané, avec badges régime & moins coûteux).
   - **Panneau reste à faire** (recos automatiques).
2. **🤖 Conseil & optimisation** : situation chiffrée + cases « priorités » + bouton « ⚡ Générer ma stratégie »
   (rapport IA structuré) + chat IA (bulles). L'IA reçoit tout le contexte de `debrief`.
3. **👪 Famille** : personnes (nom, âge/naissance, rôle) + choix du **régime matrimonial**.
4. **🏦 Patrimoine** : actifs **groupés par catégorie repliable** (`.cat-group`), fiches `.asset-card`
   (valeur marchande, prix d'acquisition, plus-value, surface m², dettes liées), détentions PP/US/NP.
5. **🏭 Entreprise** : espace dédié (forme, pacte Dutreil, démembrement des titres, usufruit).
6. **🛡️ Assurance-vie** : contrats (établissement, souscripteur/co-adhésion, capital, régime avant/après 70,
   bénéficiaires cochables + répartition %, clause).
7. **🏛️ Par banque** : regroupement des avoirs par établissement.
8. **🎁 Donations réalisées** : liste (date, donateur→bénéficiaire, montant, statut « rapportable <15 ans / purgé »).
9. **📊 Abattements dispo.** : jauges par couple parent→enfant.
10. **🧮 Simulateur** : PP / NP / US (art. 669).
11. **📚 Barèmes** : tables fiscales de référence.
12. **📥 Données & sauvegarde** : URL Worker + mot de passe, import/export CSV, cloud.

---

## 8. Ce qu'on demande d'améliorer (MISSION AFFICHAGE)

L'objectif de l'utilisateur : **« bien comprendre »** sa situation d'un coup d'œil, avec un rendu **clair, hiérarchisé,
premium**. Pistes ouvertes (le designer est libre de proposer mieux) :

1. **Hiérarchie visuelle du Résumé** : c'est l'écran-clé mais il enchaîne beaucoup de cartes. Proposer une mise en
   page qui **guide l'œil** : chiffres phares (patrimoine, total droits) en évidence, puis détails repliés.
2. **Les nombres** : ce sont des montants € — soigner l'alignement (déjà `tabular-nums`), la taille, la couleur
   sémantique (droits = ambre/rouge, net = neutre/vert). Rendre les **totaux** immédiatement repérables.
3. **Les toggles imbriqués** (personne → catégorie) : améliorer l'affordance (chevrons, densité, séparateurs),
   éventuellement proposer « tout replier / tout déplier », ou des **sous-totaux** plus lisibles.
4. **Tables denses** (droits par enfant, bénéficiaires AV, scénarios) : lisibilité mobile (scroll horizontal propre),
   en-têtes clairs, lignes de total distinctes.
5. **Cohérence** entre les onglets (cartes, espacements, typographie) et **respiration** (padding, séparateurs).
6. **Cartes de synthèse** (`.result`/`.line`) : en faire des « fiches » très lisibles (le bloc « Total des droits à
   payer » et « base successorale globale » doivent frapper).
7. **Micro-interactions** discrètes (hover, focus, transitions déjà via `--tr`) sans surcharge.
8. **États vides** (« Rien de détenu ») et messages d'aide : plus soignés.
9. **Accessibilité / contraste** : conserver un thème clair lisible ; contraste AA sur le texte muet.
10. **Print / export** : idéalement une vue « résumé » propre à imprimer/partager (bonus).

### Livrable attendu du designer
- Des **modifs de `src/styles.css`** (thème, composants) et, si besoin, des **ajustements de structure HTML** dans
  les template strings des `render*()` de `src/app.js` — **sans** ajouter de dépendance, **sans** build, en
  gardant les classes/handlers existants fonctionnels et en **bumpant le `?v=N`**.
- Peut proposer de **nouvelles classes** CSS et une **refonte visuelle** des cartes/tables/toggles.
- Doit rester **responsive** et **français**, montants `fr-FR`.

---

## 9. Rappels & pièges

- **Ne pas casser** : les fonctions `debrief()` (calculs) et les handlers d'événements. L'affichage consomme les
  champs listés au §5 — ne pas renommer ces champs.
- **Cache-busting obligatoire** après toute édition (sinon rien ne change en ligne).
- **Aucune donnée réelle** dans le repo (public).
- **Mermaid** est la seule lib externe (import dynamique) — thème `default`, à garder lisible en clair.
- Barèmes fiscaux dans `src/data.js` (indicatifs 2026) — **ne pas** les modifier pour l'affichage.

---

*Ce brief peut être transmis tel quel à un designer ou à Claude Fable 5. Il décrit l'existant ; toute proposition
d'amélioration de l'affichage est bienvenue dans le respect des contraintes ci-dessus.*
