// =============================================================
//  Organigramme (Mermaid) + Débrief patrimonial
// =============================================================
import { ABATTEMENTS, DELAI_RAPPEL_ANS, AV_AVANT_70, AV_APRES_70, calculDroits, BAREME_LIGNE_DIRECTE, tauxUsufruit } from "./data.js?v=40";

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

  // Assurance-vie
  let avAvant70 = 0, avApres70 = 0;
  av.forEach((a) => (a.avant70 ? (avAvant70 += a.montant) : (avApres70 += a.montant)));

  // AV : capital réparti par bénéficiaire (selon répartition %, sinon parts égales)
  const avBenef = {};
  av.forEach((a) => {
    const m = Number(a.montant) || 0;
    const bens = a.beneficiaires || [];
    if (!bens.length || m <= 0) return;
    const rep = a.repartition || {};
    const totalRep = bens.reduce((s, b) => s + (Number(rep[b]) || 0), 0);
    bens.forEach((b) => {
      const share = totalRep > 0 ? (Number(rep[b]) || 0) / totalRep : 1 / bens.length;
      (avBenef[b] ||= { avant70: 0, apres70: 0 });
      if (a.avant70) avBenef[b].avant70 += m * share;
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
  const apres70Reintegre = Math.max(0, avApres70 - AV_APRES_70.abattementGlobal);

  // « Si décès aujourd'hui » — détail par enfant.
  // Hypothèse simple : patrimoine réparti également entre les enfants, chaque
  // enfant bénéficiant d'un abattement de 100 000 € par parent (art. 779),
  // diminué des donations déjà consenties dans les 15 ans (rappel fiscal).
  // Exonération Dutreil : 75 % de la valeur des titres d'entreprise éligibles
  // détenus par des personnes physiques sortent de la base taxable.
  let exonerationDutreil = 0;
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return;
    const a = actif(d.actifRef);
    if (a && a.categorie === "entreprise" && a.dutreil) {
      exonerationDutreil += (DUTREIL_EXO * actifNet(d.actifRef) * d.part) / 100;
    }
  });
  const patrimoineTaxable = Math.max(0, patrimoineFoyer - exonerationDutreil);

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
  const shareOf = (pid) => (patrimoineFoyer > 0 ? Math.max(0, D.parPersonne[pid] || 0) / patrimoineFoyer : 0);
  const regime = state.regime || "";

  // Masse taxable des BIENS attribuée à chaque décès + hypothèse retenue
  let attribution = false, masseBiens1, masseBiens2, hypothese;
  if (!conjoint) {
    masseBiens1 = patrimoineTaxable; masseBiens2 = 0;
    hypothese = "Parent seul : transmission directe aux enfants (2 abattements non applicables).";
  } else if (regime === "universelle_attribution") {
    attribution = true; masseBiens1 = 0; masseBiens2 = patrimoineTaxable;
    hypothese = "Communauté universelle + attribution intégrale : au 1er décès tout revient au conjoint sans droits ; les enfants ne sont taxés qu'au 2d décès, avec un SEUL abattement de 100 000 € par enfant (celui du 1er parent est perdu).";
  } else if (regime === "universelle") {
    masseBiens1 = patrimoineTaxable * 0.5; masseBiens2 = patrimoineTaxable * 0.5;
    hypothese = "Communauté universelle : masse partagée 50/50, les enfants héritent en pleine propriété de la part du défunt à chaque décès (hypothèse v1).";
  } else if (regime === "acquets") {
    masseBiens1 = patrimoineTaxable * shareOf(defuntId); masseBiens2 = patrimoineTaxable * shareOf(conjoint.id);
    hypothese = "Communauté réduite aux acquêts (v1) : part de chacun estimée d'après sa détention dans l'app, enfants héritant en pleine propriété. Hypothèse simplifiée — l'usufruit légal du conjoint n'est pas modélisé.";
  } else {
    masseBiens1 = patrimoineTaxable * shareOf(defuntId); masseBiens2 = patrimoineTaxable * shareOf(conjoint.id);
    hypothese = "Estimation non différenciée par régime (v1) : part de chacun estimée d'après sa détention dans l'app.";
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

  // Taxation 990 I (primes avant 70 ans) par bénéficiaire, sur un jeu de contrats
  const taxeAV990 = (contrats) => {
    const benef = {};
    contrats.filter((a) => a.avant70).forEach((a) => {
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
  const reintegreApres70 = (contrats) => Math.max(0, contrats.filter((a) => !a.avant70).reduce((t, a) => t + (Number(a.montant) || 0), 0) - AV_APRES_70.abattementGlobal);

  // Contrats dénoués : au 1er décès ceux du défunt (hors co-adhésion) ; au 2d ceux du conjoint + toute co-adhésion
  const contrats1 = av.filter((a) => a.souscripteurId === defuntId && !a.cosouscripteurId);
  const contrats2 = av.filter((a) => (conjoint && a.souscripteurId === conjoint.id && !a.cosouscripteurId) || a.cosouscripteurId);

  // 1er décès
  const reint1 = reintegreApres70(contrats1);
  const enf1 = partEnfants(masseBiens1 + reint1, defuntId);
  const av1 = taxeAV990(contrats1);
  const droitsAV1 = av1.reduce((s, x) => s + x.droits, 0);
  const avDenouees1 = contrats1.filter((a) => a.avant70).map((a) => ({ contrat: a.libelle || a.id, beneficiaires: taxeAV990([a]) }));
  const totalDroitsPremier = enf1.total + droitsAV1;
  const abattementsPerdus = attribution ? ABATTEMENTS.enfant * enfants.length : 0;

  // 2d décès (conjoint survivant, « demain »)
  const reint2 = reintegreApres70(contrats2);
  const enf2 = partEnfants(masseBiens2 + reint2, conjoint ? conjoint.id : null);
  const av2 = taxeAV990(contrats2);
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
