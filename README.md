# 🏛️ Patrimoine Famille

Application web autonome pour **visualiser et simuler la transmission patrimoniale**
d'un foyer (2 parents + 3 enfants ici, mais entièrement paramétrable).

Pensée pour répondre à des questions concrètes :

- **Qu'a-t-on déjà donné, à qui, et quand ?** (historique des donations)
- **Combien reste-t-il à donner en franchise de droits ?** (abattements dispo, par parent × enfant)
- **Quelles donations sont encore « rapportables » ?** (rappel fiscal des 15 ans, purge automatique)
- **Combien coûterait telle transmission ?** (simulateur avec barème 2026)
- **Que gagne-t-on à démembrer ?** (usufruit / nue-propriété, art. 669 CGI)
- **Assurance-vie** : régime avant / après 70 ans (990 I / 757 B)

## 🚀 Utilisation

Aucune installation, aucune dépendance, aucun serveur. Ouvre simplement `index.html`
dans un navigateur — ou sers le dossier :

```bash
cd patrimoine-famille
python3 -m http.server 8000
# puis http://localhost:8000
```

> Les données sont stockées **localement** dans le navigateur (`localStorage`).
> Rien n'est envoyé sur Internet. Boutons **Exporter / Importer** pour sauvegarder en JSON.

## 🧩 Onglets

| Onglet | Rôle |
|---|---|
| 👪 Famille | Composition du foyer, dates de naissance (pour le barème 669) |
| 🎁 Donations réalisées | Historique + statut du rappel fiscal (rapportable / purgée) |
| 📊 Abattements dispo. | Matrice parent × enfant : capacité de donation exonérée restante |
| 🧮 Simulateur | Coût d'une donation/succession, avec option démembrement |
| 🛡️ Assurance-vie | Fiscalité au décès selon l'âge de versement des primes |
| 📚 Barèmes | Tables de référence (droits, abattements, usufruit, AV) |

## 📐 Barèmes intégrés (indicatifs 2026)

- Droits en ligne directe : 5 % → 45 % (CGI art. 777)
- Abattement enfant : 100 000 € / parent / enfant, rechargé tous les 15 ans (art. 779)
- Don familial de somme d'argent : 31 865 € (art. 790 G)
- Démembrement : barème d'usufruit par âge (art. 669)
- Assurance-vie : 152 500 € / bénéficiaire (990 I), abattement global 30 500 € (757 B)

Tous les barèmes sont centralisés dans [`src/data.js`](src/data.js) — faciles à mettre à
jour à chaque loi de finances.

## ⚠️ Avertissement

Outil d'aide à la décision **à visée pédagogique**. Les résultats sont des estimations
et ne remplacent pas le conseil d'un **notaire** ou d'un conseiller en gestion de
patrimoine. Vérifier les barèmes en vigueur.

## 🗂️ Structure

```
patrimoine-famille/
├── index.html          # point d'entrée
└── src/
    ├── data.js         # barèmes & fonctions de calcul fiscal
    ├── app.js          # état, persistance, rendu des onglets
    └── styles.css      # thème sombre
```
