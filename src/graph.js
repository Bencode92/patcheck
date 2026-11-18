// =============================================================
//  Organigramme (Mermaid) + Débrief patrimonial
// =============================================================
import { ABATTEMENTS, DELAI_RAPPEL_ANS, AV_AVANT_70, AV_APRES_70, calculDroits, BAREME_LIGNE_DIRECTE, tauxUsufruit, dansRappel, rappelFiscal, droitsAvecRappel } from "./data.js?v=111";

// Année de naissance : la DATE complète prime (plus précise), puis année seule, puis âge
function birthYear(p) {
  if (!p) return null;
  if (p.naissance) { const n = new Date(p.naissance); if (Number.isFinite(n.getFullYear())) return n.getFullYear(); }
  if (p.annee) return Number(p.annee);
  if (p.age != null && p.age !== "") return new Date().getFullYear() - Number(p.age);
  return null;
}
// Âge d'une personne aujourd'hui (ou à un millésime donné)
function ageDePers(p, anneeRef) {
  const by = birthYear(p);
  if (by == null) return null;
  return (anneeRef || new Date().getFullYear()) - by;
}

// Régime fiscal effectif d'un contrat au dénouement :
//  - AV classique : selon le flag saisi (primes versées avant/après 70 ans).
//  - PER assurantiel (a.per) : selon l'âge du SOUSCRIPTEUR au décès (< 70 → 990 I,
//    ≥ 70 → 757 B). On utilise l'âge courant comme proxy du « décès aujourd'hui/demain ».
export function avAvant70Effectif(a, personnes) {
  if (!a || !a.per) return !!(a && a.avant70);
  const sousc = personnes.find((p) => p.id === a.souscripteurId);
  const age = ageDePers(sousc);
  return age != null ? age < 70 : true;
}

// Taux d'exonération Dutreil (art. 787 B) sur les titres de société éligibles
const DUTREIL_EXO = 0.75;

const eur0 = (n) => Math.round(n || 0).toLocaleString("fr-FR") + " €";
function anneesEcoulees(d) {
  return (new Date() - new Date(d)) / (365.25 * 864e5);
}
// Droits 990 I sur le capital reçu par UN bénéficiaire d'UN assuré
function droits990I(cap) {
  const base = Math.max(0, cap - AV_AVANT_70.abattement);
  const t1 = Math.min(base, AV_AVANT_70.seuilTranche1), t2 = Math.max(0, base - AV_AVANT_70.seuilTranche1);
  return { base, droits: Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2) };
}
// Part de chaque bénéficiaire dans un contrat (répartition %, sinon parts égales)
function partsBenef(a) {
  const bens = a.beneficiaires || [];
  const rep = a.repartition || {};
  const tot = bens.reduce((s, b) => s + (Number(rep[b]) || 0), 0);
  return bens.map((b) => [b, tot > 0 ? (Number(rep[b]) || 0) / tot : 1 / bens.length]);
}
// Assiette 757 B d'un contrat : les PRIMES versées après 70 ans (pas les gains).
// Champ « primes » facultatif ; à défaut, le capital sert d'approximation (majorante).
const assiette757B = (a) => {
  if (a.per) return Number(a.montant) || 0; // PER : primes + gains (choix prudent de l'app)
  const pr = Number(a.primes);
  return pr > 0 ? Math.min(pr, Number(a.montant) || pr) : Number(a.montant) || 0;
};

// Nettoie un libellé pour Mermaid
const clean = (s) => String(s || "").replace(/["\n]/g, " ").replace(/[<>]/g, "").trim();

// Construit la définition Mermaid (flowchart) à partir de l'état
export function buildMermaid(state) {
  const L = ["flowchart TD"];
  const nom = (id) => {
    const p = state.personnes.find((x) => x.id === id);
    if (p) return p.nom;
    const a = (state.actifs || []).find((x) => x.id === id);
    return a ? a.libelle : id;
  };

  // Sous-graphe des personnes
  L.push('  subgraph FOYER["👪 Foyer"]');
  state.personnes.forEach((p) => {
    const cls = p.role === "parent" ? "parent" : "enfant";
    L.push(`    ${p.id}("${clean(p.nom)}<br/><small>${p.role}</small>"):::${cls}`);
  });
  L.push("  end");

  // Actifs (formes selon catégorie)
  (state.actifs || []).forEach((a) => {
    const lbl = `${clean(a.libelle)}<br/><b>${eur0(a.valeur)}</b>`;
    if (a.categorie === "sci") L.push(`  ${a.id}{{"🏢 ${lbl}"}}:::sci`);
    else if (a.categorie === "immobilier") L.push(`  ${a.id}["🏠 ${lbl}"]:::immo`);
    else if (a.categorie === "entreprise") L.push(`  ${a.id}[["🏭 ${lbl}${a.dutreil ? "<br/><small>Dutreil −75%</small>" : ""}"]]:::entreprise`);
    else if (a.categorie === "liquidites") L.push(`  ${a.id}[("💶 ${lbl}")]:::cash`);
    else if (a.categorie === "titres") L.push(`  ${a.id}["📈 ${lbl}"]:::titres`);
    else if (a.categorie === "capitalisation") L.push(`  ${a.id}[("🏦 ${lbl}")]:::capi`);
    else L.push(`  ${a.id}["${lbl}"]:::autre`);
  });

  // Détentions : propriétaire --part%/droit--> actif
  (state.detentions || []).forEach((d) => {
    const label = `${d.part}% ${d.droit}`;
    if (d.droit === "NP") L.push(`  ${d.proprietaire} -.->|"${label}"| ${d.actifRef}`);
    else if (d.droit === "US") L.push(`  ${d.proprietaire} -.->|"${label}"| ${d.actifRef}`);
    else L.push(`  ${d.proprietaire} -->|"${label}"| ${d.actifRef}`);
  });

  // Contrats AV
  (state.av || []).forEach((a) => {
    L.push(`  ${a.id}[/"🛡️ ${clean(a.libelle)}<br/><b>${eur0(a.montant)}</b><br/><small>${a.avant70 ? "avant 70 ans" : "après 70 ans"}</small>"/]:::av`);
    if (a.souscripteurId) L.push(`  ${a.souscripteurId} --> ${a.id}`);
    if (a.cosouscripteurId) L.push(`  ${a.cosouscripteurId} -->|co-adh.| ${a.id}`);
    (a.beneficiaires || []).forEach((b) => L.push(`  ${a.id} -.->|bénéf.| ${b}`));
  });

  // Dettes (nœud rouge relié à l'actif/personne grevé)
  (state.dettes || []).forEach((x) => {
    L.push(`  ${x.id}>"💳 ${clean(x.libelle)}<br/><b>− ${eur0(x.montant)}</b>"]:::dette`);
    if (x.cible) L.push(`  ${x.id} -.->|dette| ${x.cible}`);
  });

  // Donations (arêtes épaisses avec montant + date)
  state.donations.forEach((d) => {
    const an = new Date(d.date).getFullYear() || "";
    L.push(`  ${d.donateurId} ==>|"🎁 ${eur0(d.montant)} (${an})"| ${d.beneficiaireId}`);
  });

  // Styles
  L.push("  classDef parent fill:#dbeafe,stroke:#1668e3,color:#0f2747,stroke-width:2px;");
  L.push("  classDef enfant fill:#d6f5e6,stroke:#0a9d6e,color:#0f2747,stroke-width:2px;");
  L.push("  classDef sci fill:#fff0d6,stroke:#c77700,color:#0f2747;");
  L.push("  classDef immo fill:#ede7ff,stroke:#7c5cff,color:#0f2747;");
  L.push("  classDef entreprise fill:#fde4f4,stroke:#c026a3,color:#0f2747;");
  L.push("  classDef cash fill:#d6f5ef,stroke:#0a9d6e,color:#0f2747;");
  L.push("  classDef titres fill:#dce7ff,stroke:#3b6fe0,color:#0f2747;");
  L.push("  classDef capi fill:#e2f0e9,stroke:#0a9d6e,color:#0f2747;");
  L.push("  classDef av fill:#ffe0ee,stroke:#e0489a,color:#0f2747;");
  L.push("  classDef dette fill:#ffe0dd,stroke:#d92d20,color:#0f2747;");
  L.push("  classDef autre fill:#eef3fa,stroke:#5c7691,color:#0f2747;");
  return L.join("\n");
}

// ------------------- Débrief chiffré -------------------
export function debrief(state) {
  const personnes = state.personnes;
  const actifs = state.actifs || [];
  const detentions = state.detentions || [];
  const donations = state.donations || [];
  const av = state.av || [];
  const parents = personnes.filter((p) => p.role === "parent");
  const enfants = personnes.filter((p) => p.role === "enfant");
  const dettes = state.dettes || [];
  const actif = (id) => actifs.find((a) => a.id === id);
  const estPersonne = (id) => personnes.some((p) => p.id === id);
  const estActif = (id) => actifs.some((a) => a.id === id);

  // Dettes : ventilées par actif (grèvent la valeur du bien/SCI) ou par
  // personne (passif personnel). Elles réduisent l'assiette taxable.
  const detteParActif = {}, detteParPersonne = {};
  let totalDettes = 0;
  dettes.forEach((x) => {
    totalDettes += x.montant;
    if (estActif(x.cible)) detteParActif[x.cible] = (detteParActif[x.cible] || 0) + x.montant;
    else if (estPersonne(x.cible)) detteParPersonne[x.cible] = (detteParPersonne[x.cible] || 0) + x.montant;
  });
  const actifNet = (id) => {
    const a = actif(id);
    return a ? Math.max(0, a.valeur - (detteParActif[id] || 0)) : 0;
  };

  // Âge de l'usufruitier par actif, FIGÉ à l'année du démembrement (barème 669
  // cristallisé à la date de la donation, pas recalculé au fil du temps).
  // Plusieurs usufruitiers sur un même bien (ex. bien commun : chaque parent donne sa
  // moitié) → chaque quote-part est valorisée à l'âge de SON usufruitier (art. 669).
  const usuAgeParActif = {};   // âge retenu pour l'affichage (le plus jeune)
  const usuTauxParActif = {};  // taux d'usufruit moyen pondéré par les quote-parts
  const usuAcc = {};
  detentions.forEach((d) => {
    if (d.droit === "US") {
      const a = actif(d.actifRef);
      const anneeRef = a && a.demembrementAnnee ? Number(a.demembrementAnnee) : undefined;
      const age = ageDePers(personnes.find((p) => p.id === d.proprietaire), anneeRef);
      if (age == null) return;
      usuAgeParActif[d.actifRef] = Math.min(usuAgeParActif[d.actifRef] ?? 999, age);
      const w = Number(d.part) || 0;
      const acc = (usuAcc[d.actifRef] ||= { w: 0, t: 0 });
      acc.w += w; acc.t += w * tauxUsufruit(age);
    }
  });
  Object.entries(usuAcc).forEach(([id, x]) => { if (x.w > 0) usuTauxParActif[id] = x.t / x.w; });
  // Repli quand aucune ligne "usufruit" n'est saisie : usufruit réservé par le couple
  // -> barème 669 sur l'usufruitier LE PLUS JEUNE (l'usufruit dure jusqu'au dernier décès),
  // à l'année du démembrement de l'actif (pas l'âge actuel).
  const usuAge = (actifId) => {
    if (usuAgeParActif[actifId] != null) return usuAgeParActif[actifId];
    const a = actif(actifId);
    const anneeRef = a && a.demembrementAnnee ? Number(a.demembrementAnnee) : undefined;
    const ages = parents.map((p) => ageDePers(p, anneeRef)).filter((x) => x != null);
    return ages.length ? Math.min(...ages) : 65;
  };

  // Valeur ÉCONOMIQUE d'une détention : PP = pleine ; US = %usufruit ; NP = %nue-propriété
  // (US + NP sur les mêmes parts = la valeur pleine, pas de double compte).
  const usuTaux = (actifId) => usuTauxParActif[actifId] ?? tauxUsufruit(usuAge(actifId));
  const ageUsufruitierLigne = (d) => {
    const a = actif(d.actifRef);
    const anneeRef = a && a.demembrementAnnee ? Number(a.demembrementAnnee) : undefined;
    return ageDePers(personnes.find((p) => p.id === d.proprietaire), anneeRef);
  };
  const fractionDroit = (d) => {
    if (d.droit === "US") { const ag = ageUsufruitierLigne(d); return ag != null ? tauxUsufruit(ag) : usuTaux(d.actifRef); }
    if (d.droit === "NP") return 1 - usuTaux(d.actifRef);
    return 1;
  };
  const valeurEconomique = (d) => (actifNet(d.actifRef) * (Number(d.part) || 0)) / 100 * fractionDroit(d);

  // Patrimoine NET détenu par les personnes (biens logés en SCI non recomptés :
  // les personnes détiennent les parts de SCI ; dette de la SCI déjà déduite).
  const parPersonne = {};
  const parPersonneDetail = {};
  personnes.forEach((p) => { parPersonne[p.id] = 0; parPersonneDetail[p.id] = []; });
  let patrimoineFoyer = 0;
  const nomDe = (id) => (personnes.find((p) => p.id === id) || {}).nom || id;
  const foyerLignes = []; // détail « Patrimoine net des biens » (bien par bien)
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return; // détenu par une SCI -> ignoré au niveau foyer
    const a = actif(d.actifRef);
    if (!a) return;
    const val = valeurEconomique(d); // US/NP valorisés au barème 669
    parPersonne[d.proprietaire] += val;
    patrimoineFoyer += val;
    foyerLignes.push({ libelle: a.libelle || a.id, categorie: a.categorie, nom: nomDe(d.proprietaire), part: Number(d.part) || 0, droit: d.droit, fraction: fractionDroit(d), valeurBien: actifNet(d.actifRef), valeur: val });
    parPersonneDetail[d.proprietaire].push({ libelle: a.libelle || a.id, categorie: a.categorie, part: d.part, droit: d.droit, valeur: val, fraction: fractionDroit(d), usuAge: usuAge(d.actifRef) });
  });
  // Dettes personnelles
  Object.entries(detteParPersonne).forEach(([pid, m]) => {
    if (parPersonne[pid] !== undefined) parPersonne[pid] -= m;
    patrimoineFoyer -= m;
    foyerLignes.push({ libelle: "Dette personnelle", categorie: "dette", nom: nomDe(pid), part: null, droit: "", fraction: 1, valeurBien: m, valeur: -m });
  });

  // Répartition par catégorie (valeur nette)
  const parCategorie = {};
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return;
    const a = actif(d.actifRef);
    if (!a) return;
    parCategorie[a.categorie] = (parCategorie[a.categorie] || 0) + valeurEconomique(d);
  });

  // Donations : total, rapportables (<15 ans date à date), purgées
  const today = new Date();
  let dejaDonneTotal = 0, rapportable = 0;
  donations.forEach((d) => {
    dejaDonneTotal += Number(d.montant) || 0;
    if (dansRappel(d.date, today)) rapportable += Number(d.montant) || 0;
  });

  // Abattements restants par couple parent -> enfant (790 G hors abattement, art. 784)
  const rappel = (parId, enfId) => rappelFiscal(donations, parId, enfId, today);
  const abatt = [];
  let capaciteExoneree = 0;
  parents.forEach((par) => {
    enfants.forEach((enf) => {
      const r = rappel(par.id, enf.id);
      capaciteExoneree += r.abattementRestant;
      abatt.push({ parent: par.nom, enfant: enf.nom, consomme: r.abattementConsomme, restant: r.abattementRestant, don790: r.don790 });
    });
  });

  // Assurance-vie (+ PER assurantiels). Régime effectif via avAvant70Effectif().
  // Le conjoint bénéficiaire est TOTALEMENT exonéré (loi TEPA, 990 I et 757 B) :
  //  - clause « conjoint à défaut enfants » quand le conjoint est vivant ;
  //  - conjoint désigné nommément (parent ≠ assuré coché comme bénéficiaire).
  // Snapshot « décès aujourd'hui » : le conjoint est réputé vivant.
  const isParent = (id) => parents.some((p) => p.id === id);
  const goesToConjoint = (a) => (a.clauseType || "designe") === "conjoint_defaut_enfants" && parents.some((p) => p.id !== a.souscripteurId);
  let avAvant70 = 0, avApres70 = 0;
  av.forEach((a) => (avAvant70Effectif(a, personnes) ? (avAvant70 += a.montant) : (avApres70 += a.montant)));

  // 990 I : abattement 152 500 € par couple ASSURÉ → bénéficiaire (pas par bénéficiaire tous assurés)
  const av990 = {};   // clé assuré|bénéficiaire
  const avBenef = {}; // cumul par bénéficiaire (affichage)
  // 757 B : primes après 70 ans, abattement 30 500 € par ASSURÉ, réintégrées dans SA succession
  // au nom de chaque bénéficiaire (au prorata de sa part du contrat)
  const p757 = {};    // assuré -> { total, parBenef: {b: assiette} }
  av.forEach((a) => {
    const m = Number(a.montant) || 0;
    if (!(a.beneficiaires || []).length || m <= 0 || goesToConjoint(a)) return;
    const av70 = avAvant70Effectif(a, personnes);
    const assure = a.souscripteurId || "?";
    partsBenef(a).forEach(([b, share]) => {
      if (isParent(b) && b !== a.souscripteurId) return; // conjoint désigné → exonéré
      (avBenef[b] ||= { avant70: 0, apres70: 0 });
      if (av70) {
        avBenef[b].avant70 += m * share;
        av990[assure + "|" + b] = (av990[assure + "|" + b] || 0) + m * share;
      } else {
        avBenef[b].apres70 += m * share;
        const x = (p757[assure] ||= { total: 0, parBenef: {} });
        const ass = assiette757B(a) * share;
        x.total += ass;
        x.parBenef[b] = (x.parBenef[b] || 0) + ass;
      }
    });
  });
  const avParBenefDroits = {};
  Object.entries(av990).forEach(([k, cap]) => {
    const b = k.split("|")[1];
    const r = droits990I(cap);
    const o = (avParBenefDroits[b] ||= { base: 0, droits: 0, abattement: 0 });
    o.base += r.base; o.droits += r.droits; o.abattement += Math.min(cap, AV_AVANT_70.abattement);
  });
  const avBeneficiaires = Object.entries(avBenef).map(([pid, v]) => {
    const nom = personnes.find((p) => p.id === pid)?.nom || pid;
    const r = avParBenefDroits[pid] || { base: 0, droits: 0, abattement: 0 };
    return { nom, capital: v.avant70, apres70: v.apres70, abattement: r.abattement, base: r.base, droits: r.droits, net: v.avant70 - r.droits };
  }).filter((x) => x.capital > 0);
  const totalDroitsAV = avBeneficiaires.reduce((s, x) => s + x.droits, 0);
  // Montant réintégré par assuré et par bénéficiaire (après abattement 30 500 € de l'assuré)
  const reint757 = {}; // assuré -> { b: montant réintégré }
  let apres70Reintegre = 0;
  Object.entries(p757).forEach(([assure, x]) => {
    const reste = Math.max(0, x.total - AV_APRES_70.abattementGlobal);
    const k = x.total > 0 ? reste / x.total : 0;
    reint757[assure] = {};
    // Seule la part revenant aux ENFANTS entre dans leur base (les autres bénéficiaires
    // sont taxés selon leur propre lien, non modélisé ici).
    Object.entries(x.parBenef).forEach(([b, v]) => {
      reint757[assure][b] = v * k;
      if (enfants.some((e) => e.id === b)) apres70Reintegre += v * k;
    });
  });
  // « Si décès aujourd'hui » — détail par enfant.
  // Hypothèse simple : patrimoine réparti également entre les enfants, chaque
  // enfant bénéficiant d'un abattement de 100 000 € par parent (art. 779),
  // diminué des donations déjà consenties dans les 15 ans (rappel fiscal).
  // ---- Assiette TRANSMISE au décès des parents ----
  // Seuls les biens des PARENTS se transmettent, et uniquement en pleine ou nue-propriété :
  //  - l'USUFRUIT d'un parent s'éteint SANS droits au décès (art. 1133 CGI) -> exclu ;
  //  - les biens détenus par les ENFANTS (nue-propriété déjà donnée) ne se transmettent
  //    pas au décès des parents (ils sont déjà à eux) -> exclus ;
  //  - Dutreil (−75 %) ne s'applique ici qu'aux parts entreprise SOUS PACTE encore
  //    détenues par les parents (l'exonération de la donation passée est un autre événement).
  let exonerationDutreil = 0;    // −75 % sur les parts entreprise détenues par les parents (pacte)
  let dutreilAssiette = 0;       // valeur des parts entreprise détenues éligibles (avant −75 %)
  let abattementRP = 0;          // −20 % résidence principale (art. 764 bis)
  const masseTransmiseParPar = {};
  const taxableParCategorie = {};
  parents.forEach((p) => (masseTransmiseParPar[p.id] = 0));
  // Détail : lignes retenues dans la base (par catégorie) et lignes EXCLUES (avec la raison)
  const taxableLignes = [], exclusLignes = [];
  detentions.forEach((d) => {
    const p = personnes.find((x) => x.id === d.proprietaire);
    const a = actif(d.actifRef);
    if (!p || !a) return;
    const ligne = { libelle: a.libelle || a.id, categorie: a.categorie, nom: p.nom, part: Number(d.part) || 0, droit: d.droit, fraction: fractionDroit(d), valeurBien: actifNet(d.actifRef) };
    if (p.role !== "parent") { // seuls les biens des parents se transmettent
      exclusLignes.push({ ...ligne, valeur: valeurEconomique(d), raison: d.droit === "NP" ? "nue-propriété déjà donnée à l'enfant" : "déjà détenu par l'enfant" });
      return;
    }
    if (d.droit === "US") {                // usufruit : extinction franche de droits (art. 1133)
      exclusLignes.push({ ...ligne, valeur: valeurEconomique(d), raison: "usufruit du parent : s'éteint au décès sans droits (art. 1133)" });
      return;
    }
    let v = valeurEconomique(d);           // PP = pleine valeur ; NP = fraction nue-propriété
    const brut = v;
    let exo = 0;
    if (a.categorie === "entreprise" && a.dutreil) {
      dutreilAssiette += v;
      exo = DUTREIL_EXO * v;
      exonerationDutreil += exo;
      v -= exo;                            // ne reste que les 25 % taxables
    }
    // Résidence principale occupée par le conjoint / un enfant mineur : −20 % (art. 764 bis)
    let rp = 0;
    if (a.categorie === "immobilier" && a.residencePrincipale) {
      rp = 0.2 * v;
      abattementRP += rp;
      v -= rp;
    }
    masseTransmiseParPar[d.proprietaire] += v;
    taxableParCategorie[a.categorie] = (taxableParCategorie[a.categorie] || 0) + v;
    taxableLignes.push({ ...ligne, brut, exo, rp, valeur: v });
  });
  // Dettes personnelles d'un parent réduisent sa masse transmissible
  Object.entries(detteParPersonne).forEach(([pid, m]) => {
    const p = personnes.find((x) => x.id === pid);
    if (p && p.role === "parent" && masseTransmiseParPar[pid] !== undefined)
      masseTransmiseParPar[pid] = Math.max(0, masseTransmiseParPar[pid] - m);
  });
  const patrimoineTaxable = Math.max(0, Object.values(masseTransmiseParPar).reduce((s, v) => s + v, 0));
  if (apres70Reintegre > 0) taxableParCategorie.av_apres70 = apres70Reintegre;

  // ---- Droits de succession : UNE succession PAR PARENT ----
  // Chaque parent transmet SA masse ; chaque enfant a 100 000 € d'abattement par parent
  // (diminué des donations de CE parent < 15 ans) et le barème repart à zéro dans chaque
  // succession (tranches basses déjà utilisées par les donations : art. 784).
  // Hypothèses : masse de chaque parent partagée à égalité entre les enfants ; droits du
  // conjoint survivant ignorés (exonéré) ; en attribution intégrale, tout passe au conjoint
  // au 1er décès et les enfants héritent de l'ENSEMBLE au 2d décès (1 seul abattement).
  const n = enfants.length;
  const anneeNais = (p) => birthYear(p) ?? 0;
  // Survivant présumé en attribution intégrale : le parent le plus jeune
  const survivant = parents.length ? parents.reduce((a, b) => (anneeNais(b) > anneeNais(a) ? b : a)) : null;
  const attributionRegime = state.regime === "universelle_attribution";
  const massesBiens = (attribution) => {
    const m = {};
    parents.forEach((p) => (m[p.id] = 0));
    const tot = Object.values(masseTransmiseParPar).reduce((s, v) => s + v, 0);
    if (attribution && survivant) m[survivant.id] = tot;
    else parents.forEach((p) => (m[p.id] = masseTransmiseParPar[p.id] || 0));
    return m;
  };
  // Calcule les droits enfant par enfant. facteur : multiplie la masse de biens (FAQ « et si… »).
  const calcSuccession = ({ attribution = attributionRegime, avecAV757 = true, facteur = 1 } = {}) => {
    const masses = massesBiens(attribution);
    const parEnfant = enfants.map((enf) => {
      let part = 0, abattementTheorique = 0, consomme = 0, abattement = 0, base = 0, droits = 0, reintAV = 0;
      const detail = [];
      parents.forEach((par) => {
        const biens = n ? (masses[par.id] * facteur) / n : 0;
        const av757 = avecAV757 ? ((reint757[par.id] || {})[enf.id] || 0) : 0;
        const recu = biens + av757;
        // En attribution intégrale, l'abattement du prédécédé ne sert que si l'enfant reçoit
        // quelque chose dans SA succession (ex. AV après 70 ans).
        if (recu <= 0 && attribution && survivant && par.id !== survivant.id) return;
        const r = rappel(par.id, enf.id);
        const b = Math.max(0, recu - r.abattementRestant);
        const dr = droitsAvecRappel(b, r.baseAnterieure, BAREME_LIGNE_DIRECTE);
        part += recu; reintAV += av757; abattementTheorique += ABATTEMENTS.enfant;
        consomme += r.abattementConsomme; abattement += Math.min(recu, r.abattementRestant);
        base += b; droits += dr;
        detail.push({ parent: par.nom, recu, abattementRestant: r.abattementRestant, baseAnterieure: r.baseAnterieure, base: b, droits: dr });
      });
      return { nom: enf.nom, id: enf.id, part, reintAV, abattementTheorique, consomme, abattement, base, droits, detail };
    });
    return { parEnfant, total: parEnfant.reduce((s, x) => s + x.droits, 0) };
  };

  // Hors AV après 70 ans (vue « biens »)
  const succBiens = calcSuccession({ avecAV757: false });
  const droitsSuccessionEstimes = succBiens.total;
  const partParEnfant = n ? patrimoineFoyer / n : 0; // économique (reçu)
  const successionParEnfant = succBiens.parEnfant.map((x) => ({
    nom: x.nom, recu: partParEnfant, abattement: x.abattement, base: x.base, droits: x.droits,
    net: partParEnfant - x.droits, tauxEffectif: partParEnfant > 0 ? x.droits / partParEnfant : 0,
  }));

  // Base successorale GLOBALE = assiette taxable des biens + AV après 70 ans réintégrée.
  const baseSuccessoraleGlobale = patrimoineTaxable + apres70Reintegre;
  const nbAbatEnfant = attributionRegime ? 1 : Math.max(1, parents.length);
  const succGlob = calcSuccession({});
  const droitsSuccessionGlobaux = succGlob.total;
  const droitsParEnfant = succGlob.parEnfant;
  // Pour la FAQ : droits si la masse de BIENS valait `base` (AV 757 B inchangée)
  const droitsPourBase = (base, opts = {}) =>
    calcSuccession({ ...opts, facteur: patrimoineTaxable > 0 ? Math.max(0, base - apres70Reintegre) / patrimoineTaxable : 0 }).total;
  const totalDroitsTous = droitsSuccessionGlobaux + totalDroitsAV;

  // ------- Scénarios de transmission aux enfants (ordre des décès / régime) -------
  // Estimation ligne directe, hors assurance-vie. Un décès « simultané » donne
  // toujours DEUX successions distinctes : même coût que la transmission progressive.
  let scenarios = null;
  if (n) {
    const toScn = (r) => ({ parEnfant: r.parEnfant.map((x) => ({ nom: x.nom, recu: x.part, droits: x.droits })), total: r.total });
    const prog = toScn(calcSuccession({ attribution: false, avecAV757: false }));
    scenarios = {
      progressif: prog,
      attribution: toScn(calcSuccession({ attribution: true, avecAV757: false })),
      simultane: prog,
    };
  }
  // ------- Reste à faire / pistes d'optimisation -------
  const reco = [];
  const eur = (n) => Math.round(n).toLocaleString("fr-FR") + " €";
  if (capaciteExoneree > 0)
    reco.push({ level: "action", text: `Vous pouvez encore donner <b>${eur(capaciteExoneree)}</b> en franchise de droits (abattements parent→enfant non utilisés, 100 000 € /parent /enfant /15 ans).` });
  // Régime matrimonial
  if (state.regime === "universelle_attribution")
    reco.push({ level: "warn", text: `Régime <b>communauté universelle + attribution intégrale</b> : au 1er décès tout revient au conjoint (sans droits), mais les enfants n'héritent qu'au 2nd décès et <b>perdent l'abattement de 100 000 € du 1er parent</b> — coût fiscal accru, à arbitrer avec le notaire.` });
  // Enfants sans donation reçue
  enfants.forEach((enf) => {
    const recu = donations.filter((d) => d.beneficiaireId === enf.id).reduce((s, d) => s + d.montant, 0);
    if (recu === 0)
      reco.push({ level: "info", text: `<b>${enf.nom}</b> n'a encore reçu aucune donation : ${eur(ABATTEMENTS.enfant * parents.length)} transmissibles en franchise dès maintenant.` });
  });
  // AV sans clause bénéficiaire
  av.forEach((a) => {
    if (!a.beneficiaires || a.beneficiaires.length === 0)
      reco.push({ level: "warn", text: `Le contrat d'assurance-vie <b>${a.libelle || a.id}</b> n'a pas de clause bénéficiaire renseignée — à définir (risque de requalification au profit de la succession).` });
  });
  // Donations proches de la purge des 15 ans (l'abattement va se recharger)
  donations.forEach((d) => {
    const reste = DELAI_RAPPEL_ANS - anneesEcoulees(d.date);
    if (reste > 0 && reste < 2)
      reco.push({ level: "info", text: `La donation de ${eur(d.montant)} (${new Date(d.date).getFullYear()}) sort du rappel fiscal dans ${reste.toFixed(1)} an(s) : l'abattement correspondant se rechargera alors.` });
  });
  // Dettes déductibles
  if (totalDettes > 0)
    reco.push({ level: "ok", text: `<b>${eur(totalDettes)}</b> de dettes réduisent l'assiette taxable (levier classique : porter l'emprunt dans la SCI/société abaisse la valeur nette transmise).` });
  // Dutreil non activé sur du capital entreprise
  const entrepriseSansDutreil = actifs.filter((a) => a.categorie === "entreprise" && !a.dutreil);
  entrepriseSansDutreil.forEach((a) =>
    reco.push({ level: "action", text: `Le capital entreprise <b>${a.libelle}</b> (${eur(a.valeur)}) n'a pas de pacte Dutreil : un engagement collectif pourrait exonérer 75 % de sa valeur.` })
  );
  if (droitsSuccessionEstimes > 0 && enfants.length)
    reco.push({ level: "info", text: `Droits de succession estimés aujourd'hui : <b>${eur(droitsSuccessionEstimes)}</b>. Le démembrement (donner la nue-propriété) et les donations anticipées réduisent fortement ce montant — voir le Simulateur.` });

  return {
    patrimoineFoyer,
    patrimoineTaxable,
    exonerationDutreil,
    abattementRP,
    dutreilAssiette,
    taxableParCategorie,
    masseTransmiseParPar,
    totalDettes,
    regime: state.regime || "",
    parPersonneDetail,
    foyerLignes,
    taxableLignes,
    exclusLignes,
    detteParPersonne,
    droitsParEnfant,
    nbAbatEnfant,
    avBeneficiaires,
    totalDroitsAV,
    apres70Reintegre,
    baseSuccessoraleGlobale,
    droitsSuccessionGlobaux,
    droitsPourBase,
    totalDroitsTous,
    scenarios,
    reco,
    parPersonne,
    parCategorie,
    dejaDonneTotal,
    rapportable,
    purge: dejaDonneTotal - rapportable,
    abatt,
    capaciteExoneree,
    avAvant70,
    avApres70,
    droitsSuccessionEstimes,
    successionParEnfant,
    nbParents: parents.length,
    nbEnfants: enfants.length,
  };
}

// ------------------- Biens transmissibles nets (pour l'Optimiseur) -------------------
// Liste, par ACTIF détenu en pleine propriété par les PARENTS, la valeur NETTE
// (valeur marchande − dette adossée) × quote-part parents. Sert de base à
// l'arbitrage démembrement (donner la nue-propriété). Réutilise le netting dette.
export function actifsTransmissiblesParents(state) {
  const personnes = state.personnes || [];
  const actifs = state.actifs || [];
  const detentions = state.detentions || [];
  const dettes = state.dettes || [];
  const parents = personnes.filter((p) => p.role === "parent");
  const parentIds = new Set(parents.map((p) => p.id));
  const CATS = new Set(["sci", "immobilier", "entreprise", "titres", "capitalisation"]);
  // Parts en % (gère les fractions saisies « 81/500 »)
  const partNum = (v) => {
    if (typeof v === "string" && v.includes("/")) { const [x, y] = v.split("/").map(Number); return y ? (x / y) * 100 : 0; }
    return Number(v) || 0;
  };
  const actifById = (id) => actifs.find((a) => a.id === id);
  const isActif = (id) => actifs.some((a) => a.id === id);
  // Dette adossée par actif
  const detteParActif = {};
  dettes.forEach((x) => { if (isActif(x.cible)) detteParActif[x.cible] = (detteParActif[x.cible] || 0) + (Number(x.montant) || 0); });

  // Valeurs { brut, dette, net } pleines (100 %) d'un actif : sa valeur propre si
  // renseignée, SINON la somme des biens qu'il détient. Cas courant : un immeuble logé
  // dans une SCI, dont la valeur ET la dette sont portées sur l'IMMEUBLE (la SCI à 0) —
  // on remonte alors brut ET dette au niveau SCI. Récursif, borné par `seen`.
  const valeursActif = (id, seen = new Set()) => {
    if (seen.has(id)) return { brut: 0, dette: 0, net: 0 };
    seen.add(id);
    const a = actifById(id); if (!a) return { brut: 0, dette: 0, net: 0 };
    const detteA = detteParActif[id] || 0;
    const propre = Number(a.valeur) || 0;
    if (propre > 0) return { brut: propre, dette: detteA, net: Math.max(0, propre - detteA) };
    let brut = 0, dette = detteA;
    detentions.forEach((d) => {
      if (d.proprietaire === id && isActif(d.actifRef)) {
        const c = valeursActif(d.actifRef, seen), q = partNum(d.part) / 100;
        brut += c.brut * q; dette += c.dette * q;
      }
    });
    return { brut, dette, net: Math.max(0, brut - dette) };
  };

  // Âge du plus jeune parent aujourd'hui (l'usufruit dure jusqu'au dernier décès)
  const agesParents = parents.map((p) => ageDePers(p)).filter((x) => x != null);
  const ageUsufruitierAujourdhui = agesParents.length ? Math.min(...agesParents) : 65;
  // Agrège les quotes-parts PP des parents par actif
  const parActif = {};
  detentions.forEach((d) => {
    if (d.droit !== "PP" || !parentIds.has(d.proprietaire)) return;
    const a = actifById(d.actifRef);
    if (!a || !CATS.has(a.categorie)) return;
    if (a.aGarder) return; // « À garder par le propriétaire » → exclu des scénarios de donation/démembrement
    parActif[a.id] = (parActif[a.id] || 0) + partNum(d.part);
  });
  return Object.entries(parActif).map(([id, partPct]) => {
    const a = actifById(id);
    const v = valeursActif(id); // { brut, dette, net } pleins (100 %), dette nichée remontée
    return {
      id, libelle: a.libelle || id, categorie: a.categorie,
      valeurBrute: v.brut * partPct / 100,
      dette: v.dette * partPct / 100,
      valeurNette: v.net * partPct / 100,
      partPct, dutreil: !!a.dutreil, ageUsufruitierAujourdhui,
    };
  }).filter((x) => x.valeurNette > 0);
}

// ------------------- Simulation « décès par parent » (ordre des décès) -------------------
// Estime le coût fiscal selon QUEL parent décède en premier, puis le conjoint « demain ».
// v1 : hypothèses simplificatrices EXPLICITES (champ `hypothese`), à valider avec un notaire.
// Réutilise debrief() pour les agrégats + calculDroits()/barèmes de data.js.
export function simulerDeces(state, defuntId) {
  const D = debrief(state);
  const personnes = state.personnes || [];
  const parents = personnes.filter((p) => p.role === "parent");
  const enfants = personnes.filter((p) => p.role === "enfant");
  const donations = state.donations || [];
  const av = state.av || [];
  const nomDe = (id) => personnes.find((p) => p.id === id)?.nom || id;
  const defunt = personnes.find((p) => p.id === defuntId);
  if (!defunt) return null;
  const conjoint = parents.find((p) => p.id !== defuntId) || null;
  const patrimoineTaxable = D.patrimoineTaxable;
  const patrimoineFoyer = D.patrimoineFoyer;
  const masseDe = (pid) => (D.masseTransmiseParPar && D.masseTransmiseParPar[pid]) || 0;
  const regime = state.regime || "";
  const demembreNote = " L'usufruit des parents s'éteint sans droits (art. 1133) et la nue-propriété déjà donnée aux enfants n'est pas re-taxée.";

  // Masse taxable des BIENS (transmise par les parents) attribuée à chaque décès + hypothèse retenue
  let attribution = false, masseBiens1, masseBiens2, hypothese;
  if (!conjoint) {
    masseBiens1 = patrimoineTaxable; masseBiens2 = 0;
    hypothese = "Parent seul : transmission directe aux enfants (2 abattements non applicables)." + demembreNote;
  } else if (regime === "universelle_attribution") {
    attribution = true; masseBiens1 = 0; masseBiens2 = patrimoineTaxable;
    hypothese = "Communauté universelle + attribution intégrale : au 1er décès tout revient au conjoint sans droits ; les enfants ne sont taxés qu'au 2d décès, avec un SEUL abattement de 100 000 € par enfant (celui du 1er parent est perdu)." + demembreNote;
  } else if (regime === "universelle") {
    masseBiens1 = patrimoineTaxable * 0.5; masseBiens2 = patrimoineTaxable * 0.5;
    hypothese = "Communauté universelle : masse partagée 50/50, les enfants héritent en pleine propriété de la part du défunt à chaque décès (hypothèse v1)." + demembreNote;
  } else if (regime === "acquets") {
    masseBiens1 = masseDe(defuntId); masseBiens2 = masseDe(conjoint.id);
    hypothese = "Communauté réduite aux acquêts (v1) : masse transmise par chaque parent = ses biens détenus (hors usufruit), enfants héritant en pleine propriété. Hypothèse simplifiée — l'usufruit légal du conjoint n'est pas modélisé." + demembreNote;
  } else {
    masseBiens1 = masseDe(defuntId); masseBiens2 = masseDe(conjoint.id);
    hypothese = "Estimation non différenciée par régime (v1) : masse transmise par chaque parent = ses biens détenus (hors usufruit)." + demembreNote;
  }

  // Droits ligne directe des enfants dans la succession de `parentId` :
  // masse de biens partagée à égalité + AV 757 B réintégrée au nom de chaque bénéficiaire.
  // Abattement de CE parent diminué de SES donations < 15 ans (790 G hors abattement, art. 784).
  const partEnfants = (masse, parentId, reintParBenef = {}) => {
    if (!enfants.length) return { rows: [], total: 0 };
    const rows = enfants.map((enf) => {
      const part = Math.max(0, masse) / enfants.length + (reintParBenef[enf.id] || 0);
      const r = parentId ? rappelFiscal(donations, parentId, enf.id) : { abattementRestant: ABATTEMENTS.enfant, baseAnterieure: 0 };
      const ab = r.abattementRestant;
      const base = Math.max(0, part - ab);
      const droits = droitsAvecRappel(base, r.baseAnterieure, BAREME_LIGNE_DIRECTE);
      return { nom: enf.nom, recu: part, abattement: Math.min(part, ab), base, droits, net: part - droits };
    }).filter((x) => x.recu > 0);
    return { rows, total: rows.reduce((s, r) => s + r.droits, 0) };
  };

  // Le conjoint bénéficiaire est exonéré (TEPA) : clause « conjoint à défaut enfants » s'il est
  // VIVANT au dénouement, ou conjoint désigné nommément. Au 2d décès, la clause bascule sur les enfants.
  const goesToConjoint = (a) => (a.clauseType || "designe") === "conjoint_defaut_enfants" && conjoint;
  const isParent = (id) => parents.some((p) => p.id === id);
  // Ventile un jeu de contrats : capital par (assuré|bénéficiaire) en 990 I, assiette 757 B par assuré,
  // et ce qui part au CONJOINT survivant (exonéré, mais entre dans SON patrimoine).
  const ventiler = (contrats, spouseAlive) => {
    const c990 = {}, p757 = {}; let versConjoint = 0;
    contrats.forEach((a) => {
      const m = Number(a.montant) || 0; if (m <= 0) return;
      if (spouseAlive && goesToConjoint(a)) { versConjoint += m; return; }
      if (!(a.beneficiaires || []).length) return;
      const av70 = avAvant70Effectif(a, personnes), assure = a.souscripteurId || "?";
      partsBenef(a).forEach(([b, sh]) => {
        if (isParent(b) && b !== a.souscripteurId) { if (spouseAlive) versConjoint += m * sh; return; }
        if (av70) c990[assure + "|" + b] = (c990[assure + "|" + b] || 0) + m * sh;
        else { const x = (p757[assure] ||= { total: 0, parBenef: {} }); const v = assiette757B(a) * sh; x.total += v; x.parBenef[b] = (x.parBenef[b] || 0) + v; }
      });
    });
    // 990 I : abattement par couple assuré → bénéficiaire, puis cumul par bénéficiaire pour l'affichage
    const parB = {};
    Object.entries(c990).forEach(([k, cap]) => {
      const b = k.split("|")[1], r = droits990I(cap);
      const o = (parB[b] ||= { capital: 0, abattement: 0, base: 0, droits: 0 });
      o.capital += cap; o.abattement += Math.min(cap, AV_AVANT_70.abattement); o.base += r.base; o.droits += r.droits;
    });
    const av990 = Object.entries(parB).map(([pid, o]) => ({ nom: nomDe(pid), ...o, net: o.capital - o.droits })).filter((x) => x.capital > 0);
    // 757 B : abattement 30 500 € par assuré, réintégration au nom de chaque bénéficiaire
    const reint = {}; let reintTotal = 0;
    Object.values(p757).forEach((x) => {
      const reste = Math.max(0, x.total - AV_APRES_70.abattementGlobal), k = x.total > 0 ? reste / x.total : 0;
      Object.entries(x.parBenef).forEach(([b, v]) => { reint[b] = (reint[b] || 0) + v * k; });
      reintTotal += reste;
    });
    return { av990, reint, reintTotal, versConjoint };
  };

  // Contrats dénoués : au 1er décès ceux du défunt (hors co-adhésion) ; au 2d ceux du conjoint + toute co-adhésion
  const contrats1 = av.filter((a) => a.souscripteurId === defuntId && !a.cosouscripteurId);
  const contrats2 = av.filter((a) => (conjoint && a.souscripteurId === conjoint.id && !a.cosouscripteurId) || a.cosouscripteurId);

  // 1er décès (conjoint VIVANT → ce qui lui revient est exonéré)
  const v1 = ventiler(contrats1, !!conjoint);
  const enf1 = partEnfants(masseBiens1, defuntId, v1.reint);
  const av1 = v1.av990;
  const droitsAV1 = av1.reduce((s, x) => s + x.droits, 0);
  const avDenouees1 = contrats1.filter((a) => avAvant70Effectif(a, personnes) && !goesToConjoint(a)).map((a) => ({ contrat: a.libelle || a.id, beneficiaires: ventiler([a], !!conjoint).av990 }));
  const totalDroitsPremier = enf1.total + droitsAV1;
  const abattementsPerdus = attribution ? ABATTEMENTS.enfant * enfants.length : 0;

  // 2d décès : l'AV reçue par le conjoint au 1er décès est désormais dans SON patrimoine
  // (hypothèse : conservée jusqu'à son décès) → taxée au barème succession.
  const avRecueConjoint = conjoint ? v1.versConjoint : 0;
  const v2 = ventiler(contrats2, false);
  const enf2 = conjoint ? partEnfants(masseBiens2 + avRecueConjoint, conjoint.id, v2.reint) : { rows: [], total: 0 };
  const av2 = conjoint ? v2.av990 : [];
  const droitsAV2 = av2.reduce((s, x) => s + x.droits, 0);
  const totalDroitsSecond = enf2.total + droitsAV2;
  const reint2 = conjoint ? v2.reintTotal : 0;
  if (avRecueConjoint > 0) hypothese += ` L'assurance-vie reçue par le conjoint au 1er décès (${Math.round(avRecueConjoint).toLocaleString("fr-FR")} €) est réintégrée dans son patrimoine et taxée à son décès.`;

  return {
    defunt: { id: defunt.id, nom: defunt.nom, age: ageDePers(defunt) },
    conjoint: conjoint ? { id: conjoint.id, nom: conjoint.nom } : null,
    hypothese,
    premierDeces: {
      masseDefunt: masseBiens1,
      recuConjoint: attribution ? patrimoineFoyer : 0,
      droitsConjoint: 0,
      partEnfants: enf1.rows,
      avDenouees: avDenouees1,
      totalDroitsPremier,
      abattementsPerdus,
    },
    secondDeces: {
      masse: masseBiens2 + avRecueConjoint + reint2,
      avRecueConjoint,
      parEnfant: enf2.rows,
      avDenouees: av2,
      totalDroitsSecond,
    },
    totalOrdre: totalDroitsPremier + totalDroitsSecond,
  };
}
