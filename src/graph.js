// =============================================================
//  Organigramme (Mermaid) + Débrief patrimonial
// =============================================================
import { ABATTEMENTS, DELAI_RAPPEL_ANS, AV_AVANT_70, AV_APRES_70, calculDroits, BAREME_LIGNE_DIRECTE, tauxUsufruit } from "./data.js?v=89";

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
  const usuAgeParActif = {};
  detentions.forEach((d) => {
    if (d.droit === "US") {
      const a = actif(d.actifRef);
      const anneeRef = a && a.demembrementAnnee ? Number(a.demembrementAnnee) : undefined;
      const age = ageDePers(personnes.find((p) => p.id === d.proprietaire), anneeRef);
      if (age != null) usuAgeParActif[d.actifRef] = age;
    }
  });
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
  const fractionDroit = (d) =>
    d.droit === "US" ? tauxUsufruit(usuAge(d.actifRef)) : d.droit === "NP" ? 1 - tauxUsufruit(usuAge(d.actifRef)) : 1;
  const valeurEconomique = (d) => (actifNet(d.actifRef) * (Number(d.part) || 0)) / 100 * fractionDroit(d);

  // Patrimoine NET détenu par les personnes (biens logés en SCI non recomptés :
  // les personnes détiennent les parts de SCI ; dette de la SCI déjà déduite).
  const parPersonne = {};
  const parPersonneDetail = {};
  personnes.forEach((p) => { parPersonne[p.id] = 0; parPersonneDetail[p.id] = []; });
  let patrimoineFoyer = 0;
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return; // détenu par une SCI -> ignoré au niveau foyer
    const a = actif(d.actifRef);
    if (!a) return;
    const val = valeurEconomique(d); // US/NP valorisés au barème 669
    parPersonne[d.proprietaire] += val;
    patrimoineFoyer += val;
    parPersonneDetail[d.proprietaire].push({ libelle: a.libelle || a.id, categorie: a.categorie, part: d.part, droit: d.droit, valeur: val, fraction: fractionDroit(d), usuAge: usuAge(d.actifRef) });
  });
  // Dettes personnelles
  Object.entries(detteParPersonne).forEach(([pid, m]) => {
    if (parPersonne[pid] !== undefined) parPersonne[pid] -= m;
    patrimoineFoyer -= m;
  });

  // Répartition par catégorie (valeur nette)
  const parCategorie = {};
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return;
    const a = actif(d.actifRef);
    if (!a) return;
    parCategorie[a.categorie] = (parCategorie[a.categorie] || 0) + valeurEconomique(d);
  });

  // Donations : total, rapportables (<15 ans), purgées
  let dejaDonneTotal = 0, rapportable = 0;
  donations.forEach((d) => {
    dejaDonneTotal += d.montant;
    if (anneesEcoulees(d.date) < DELAI_RAPPEL_ANS) rapportable += d.montant;
  });

  // Abattements restants par couple parent -> enfant
  const abatt = [];
  let capaciteExoneree = 0;
  parents.forEach((par) => {
    enfants.forEach((enf) => {
      const consomme = donations
        .filter((d) => d.donateurId === par.id && d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS)
        .reduce((s, d) => s + d.montant, 0);
      const restant = Math.max(0, ABATTEMENTS.enfant - consomme);
      capaciteExoneree += restant;
      abatt.push({ parent: par.nom, enfant: enf.nom, consomme, restant });
    });
  });

  // Assurance-vie (+ PER assurantiels). Régime effectif via avAvant70Effectif().
  // Clause « conjoint à défaut enfants » : au 1er décès le contrat revient au conjoint
  // survivant, TOTALEMENT exonéré (loi TEPA) → 0 droit, pas de réintégration. Les enfants
  // ne sont taxés qu'au 2d décès (géré dans simulerDeces). Ici (snapshot « décès aujourd'hui »),
  // le conjoint est réputé vivant → ces contrats ne génèrent aucun droit.
  const goesToConjoint = (a) => (a.clauseType || "designe") === "conjoint_defaut_enfants" && parents.some((p) => p.id !== a.souscripteurId);
  let avAvant70 = 0, avApres70 = 0;
  av.forEach((a) => (avAvant70Effectif(a, personnes) ? (avAvant70 += a.montant) : (avApres70 += a.montant)));

  // AV : capital réparti par bénéficiaire (selon répartition %, sinon parts égales)
  const avBenef = {};
  av.forEach((a) => {
    const m = Number(a.montant) || 0;
    const bens = a.beneficiaires || [];
    if (!bens.length || m <= 0 || goesToConjoint(a)) return; // conjoint bénéficiaire → exonéré
    const av70 = avAvant70Effectif(a, personnes);
    const rep = a.repartition || {};
    const totalRep = bens.reduce((s, b) => s + (Number(rep[b]) || 0), 0);
    bens.forEach((b) => {
      const share = totalRep > 0 ? (Number(rep[b]) || 0) / totalRep : 1 / bens.length;
      (avBenef[b] ||= { avant70: 0, apres70: 0 });
      if (av70) avBenef[b].avant70 += m * share;
      else avBenef[b].apres70 += m * share;
    });
  });
  // Droits 990 I (primes avant 70 ans) par bénéficiaire
  const avBeneficiaires = Object.entries(avBenef).map(([pid, v]) => {
    const nom = personnes.find((p) => p.id === pid)?.nom || pid;
    const base = Math.max(0, v.avant70 - AV_AVANT_70.abattement);
    const t1 = Math.min(base, AV_AVANT_70.seuilTranche1);
    const t2 = Math.max(0, base - AV_AVANT_70.seuilTranche1);
    const droits = Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2);
    return { nom, capital: v.avant70, apres70: v.apres70, abattement: Math.min(v.avant70, AV_AVANT_70.abattement), base, droits, net: v.avant70 - droits };
  }).filter((x) => x.capital > 0);
  const totalDroitsAV = avBeneficiaires.reduce((s, x) => s + x.droits, 0);
  // Primes après 70 ans (757 B) : au-delà de l'abattement global, réintégrées à la succession
  // (hors contrats qui reviennent au conjoint exonéré au 1er décès)
  const apres70TaxableSum = av.filter((a) => !avAvant70Effectif(a, personnes) && !goesToConjoint(a)).reduce((s, a) => s + (Number(a.montant) || 0), 0);
  const apres70Reintegre = Math.max(0, apres70TaxableSum - AV_APRES_70.abattementGlobal);

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
  const masseTransmiseParPar = {};
  const taxableParCategorie = {};
  parents.forEach((p) => (masseTransmiseParPar[p.id] = 0));
  detentions.forEach((d) => {
    const p = personnes.find((x) => x.id === d.proprietaire);
    if (!p || p.role !== "parent") return; // seuls les biens des parents se transmettent
    if (d.droit === "US") return;          // usufruit : extinction franche de droits (art. 1133)
    const a = actif(d.actifRef);
    if (!a) return;
    let v = valeurEconomique(d);           // PP = pleine valeur ; NP = fraction nue-propriété
    if (a.categorie === "entreprise" && a.dutreil) {
      dutreilAssiette += v;
      const exo = DUTREIL_EXO * v;
      exonerationDutreil += exo;
      v -= exo;                            // ne reste que les 25 % taxables
    }
    masseTransmiseParPar[d.proprietaire] += v;
    taxableParCategorie[a.categorie] = (taxableParCategorie[a.categorie] || 0) + v;
  });
  // Dettes personnelles d'un parent réduisent sa masse transmissible
  Object.entries(detteParPersonne).forEach(([pid, m]) => {
    const p = personnes.find((x) => x.id === pid);
    if (p && p.role === "parent" && masseTransmiseParPar[pid] !== undefined)
      masseTransmiseParPar[pid] = Math.max(0, masseTransmiseParPar[pid] - m);
  });
  const patrimoineTaxable = Math.max(0, Object.values(masseTransmiseParPar).reduce((s, v) => s + v, 0));
  if (apres70Reintegre > 0) taxableParCategorie.av_apres70 = apres70Reintegre;

  let droitsSuccessionEstimes = 0;
  const successionParEnfant = [];
  const partParEnfant = enfants.length ? patrimoineFoyer / enfants.length : 0;          // économique (reçu)
  const partTaxableParEnfant = enfants.length ? patrimoineTaxable / enfants.length : 0; // après Dutreil
  enfants.forEach((enf) => {
    const consomme = donations
      .filter((d) => d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS)
      .reduce((s, d) => s + d.montant, 0);
    const abattementDispo = Math.max(0, ABATTEMENTS.enfant * parents.length - consomme);
    const base = Math.max(0, partTaxableParEnfant - abattementDispo);
    const droits = calculDroits(base, BAREME_LIGNE_DIRECTE);
    droitsSuccessionEstimes += droits;
    successionParEnfant.push({
      nom: enf.nom,
      recu: partParEnfant,
      abattement: abattementDispo,
      base,
      droits,
      net: partParEnfant - droits,
      tauxEffectif: partParEnfant > 0 ? droits / partParEnfant : 0,
    });
  });

  // Base successorale GLOBALE = assiette taxable des biens + AV après 70 ans réintégrée.
  // Droits recalculés sur cette base (l'AV après 70 ans est taxée au barème succession).
  const baseSuccessoraleGlobale = patrimoineTaxable + apres70Reintegre;
  // Nombre d'abattements enfant applicables : en attribution intégrale, tout revient
  // au conjoint au 1er décès → les enfants n'héritent qu'au 2d décès avec 1 SEUL
  // abattement (celui du 1er parent est perdu). Sinon 1 par parent.
  const nbAbatEnfant = (state.regime === "universelle_attribution") ? 1 : Math.max(1, parents.length);
  let droitsSuccessionGlobaux = 0;
  if (enfants.length) {
    const partGlob = baseSuccessoraleGlobale / enfants.length;
    enfants.forEach((enf) => {
      const consomme = donations.filter((d) => d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS).reduce((s, d) => s + d.montant, 0);
      const ab = Math.max(0, ABATTEMENTS.enfant * nbAbatEnfant - consomme);
      droitsSuccessionGlobaux += calculDroits(Math.max(0, partGlob - ab), BAREME_LIGNE_DIRECTE);
    });
  }
  const totalDroitsTous = droitsSuccessionGlobaux + totalDroitsAV;

  // ------- Scénarios de transmission aux enfants (ordre des décès / régime) -------
  // Hypothèse couple (2 parents). Estimation ligne directe, hors assurance-vie.
  let scenarios = null;
  if (enfants.length) {
    const n = enfants.length;
    const dLD = (b) => calculDroits(Math.max(0, b), BAREME_LIGNE_DIRECTE);
    const consommeEnf = (enf) =>
      donations.filter((d) => d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS).reduce((s, d) => s + d.montant, 0);
    const build = (fnDroits) => {
      const pe = enfants.map((enf) => ({ nom: enf.nom, recu: patrimoineTaxable / n, droits: fnDroits(enf) }));
      return { parEnfant: pe, total: pe.reduce((s, e) => s + e.droits, 0) };
    };
    scenarios = {
      // 2 abattements (100k × 2 parents), une seule transmission
      simultane: build((enf) => dLD(patrimoineTaxable / n - Math.max(0, ABATTEMENTS.enfant * 2 - consommeEnf(enf)))),
      // attribution intégrale : tout au conjoint au 1er décès, enfants au 2nd -> 1 seul abattement
      attribution: build((enf) => dLD(patrimoineTaxable / n - Math.max(0, ABATTEMENTS.enfant - consommeEnf(enf)))),
      // transmission à chaque décès : 2 assiettes de P/2 avec 100k chacune (tranches plus basses)
      progressif: build((enf) => {
        const demi = patrimoineTaxable / 2 / n;
        return dLD(demi - Math.max(0, ABATTEMENTS.enfant - consommeEnf(enf))) + dLD(demi - ABATTEMENTS.enfant);
      }),
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
    dutreilAssiette,
    taxableParCategorie,
    masseTransmiseParPar,
    totalDettes,
    regime: state.regime || "",
    parPersonneDetail,
    avBeneficiaires,
    totalDroitsAV,
    apres70Reintegre,
    baseSuccessoraleGlobale,
    droitsSuccessionGlobaux,
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

  // Droits ligne directe des enfants sur une masse (abattement du parent concerné, rapport donations <15 ans)
  const partEnfants = (masse, parentId) => {
    if (!enfants.length || masse <= 0) return { rows: [], total: 0 };
    const part = masse / enfants.length;
    const rows = enfants.map((enf) => {
      const consomme = parentId
        ? donations.filter((d) => d.donateurId === parentId && d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS).reduce((s, d) => s + d.montant, 0)
        : 0;
      const ab = Math.max(0, ABATTEMENTS.enfant - consomme);
      const base = Math.max(0, part - ab);
      const droits = calculDroits(base, BAREME_LIGNE_DIRECTE);
      return { nom: enf.nom, recu: part, abattement: ab, base, droits, net: part - droits };
    });
    return { rows, total: rows.reduce((s, r) => s + r.droits, 0) };
  };

  // Clause « conjoint à défaut enfants » : si le conjoint est VIVANT au dénouement (1er décès),
  // il reçoit le contrat totalement exonéré (0 droit). S'il n'est plus là (2d décès), les enfants
  // reçoivent « à défaut » et sont taxés normalement.
  const goesToConjoint = (a) => (a.clauseType || "designe") === "conjoint_defaut_enfants" && conjoint;
  // Taxation 990 I (primes avant 70 ans) par bénéficiaire, sur un jeu de contrats (spouseAlive = conjoint vivant)
  const taxeAV990 = (contrats, spouseAlive) => {
    const benef = {};
    contrats.filter((a) => avAvant70Effectif(a, personnes) && !(spouseAlive && goesToConjoint(a))).forEach((a) => {
      const m = Number(a.montant) || 0; const bens = a.beneficiaires || []; if (!bens.length || m <= 0) return;
      const rep = a.repartition || {}; const tot = bens.reduce((s, b) => s + (Number(rep[b]) || 0), 0);
      bens.forEach((b) => { const sh = tot > 0 ? (Number(rep[b]) || 0) / tot : 1 / bens.length; benef[b] = (benef[b] || 0) + m * sh; });
    });
    return Object.entries(benef).map(([pid, cap]) => {
      const base = Math.max(0, cap - AV_AVANT_70.abattement);
      const t1 = Math.min(base, AV_AVANT_70.seuilTranche1), t2 = Math.max(0, base - AV_AVANT_70.seuilTranche1);
      const droits = Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2);
      return { nom: nomDe(pid), capital: cap, abattement: Math.min(cap, AV_AVANT_70.abattement), base, droits, net: cap - droits };
    }).filter((x) => x.capital > 0);
  };
  // Primes après 70 ans réintégrées (au-delà de l'abattement global 30 500 €)
  const reintegreApres70 = (contrats, spouseAlive) => Math.max(0, contrats.filter((a) => !avAvant70Effectif(a, personnes) && !(spouseAlive && goesToConjoint(a))).reduce((t, a) => t + (Number(a.montant) || 0), 0) - AV_APRES_70.abattementGlobal);

  // Contrats dénoués : au 1er décès ceux du défunt (hors co-adhésion) ; au 2d ceux du conjoint + toute co-adhésion
  const contrats1 = av.filter((a) => a.souscripteurId === defuntId && !a.cosouscripteurId);
  const contrats2 = av.filter((a) => (conjoint && a.souscripteurId === conjoint.id && !a.cosouscripteurId) || a.cosouscripteurId);

  // 1er décès (conjoint VIVANT → clause conjoint = exonéré)
  const reint1 = reintegreApres70(contrats1, true);
  const enf1 = partEnfants(masseBiens1 + reint1, defuntId);
  const av1 = taxeAV990(contrats1, true);
  const droitsAV1 = av1.reduce((s, x) => s + x.droits, 0);
  const avDenouees1 = contrats1.filter((a) => avAvant70Effectif(a, personnes) && !goesToConjoint(a)).map((a) => ({ contrat: a.libelle || a.id, beneficiaires: taxeAV990([a], true) }));
  const totalDroitsPremier = enf1.total + droitsAV1;
  const abattementsPerdus = attribution ? ABATTEMENTS.enfant * enfants.length : 0;

  // 2d décès (conjoint décédé → clause « à défaut enfants » s'applique → enfants taxés)
  const reint2 = reintegreApres70(contrats2, false);
  const enf2 = partEnfants(masseBiens2 + reint2, conjoint ? conjoint.id : null);
  const av2 = taxeAV990(contrats2, false);
  const droitsAV2 = av2.reduce((s, x) => s + x.droits, 0);
  const totalDroitsSecond = enf2.total + droitsAV2;

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
      masse: masseBiens2 + reint2,
      parEnfant: enf2.rows,
      avDenouees: av2,
      totalDroitsSecond,
    },
    totalOrdre: totalDroitsPremier + totalDroitsSecond,
  };
}
