// =============================================================
//  Optimiseur — moteur d'aide à la décision (déterministe, pur)
//  Consomme debrief(state) + barèmes data.js. Zéro DOM.
//  Tout est INDICATIF, à valider avec un notaire.
// =============================================================
import { debrief, avAvant70Effectif } from "./graph.js?v=90";
import {
  ABATTEMENTS, DELAI_RAPPEL_ANS, AV_AVANT_70,
  BAREME_LIGNE_DIRECTE, calculDroits, tauxUsufruit,
} from "./data.js?v=90";

const PLAFOND_AV = AV_AVANT_70.abattement; // 152 500 € / bénéficiaire (990 I)

// Droits 990 I sur un capital reçu par UN bénéficiaire (après abattement 152 500 €)
export function droits990(capital) {
  const base = Math.max(0, (capital || 0) - PLAFOND_AV);
  const t1 = Math.min(base, AV_AVANT_70.seuilTranche1);
  const t2 = Math.max(0, base - AV_AVANT_70.seuilTranche1);
  return Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2);
}

// Droits ligne directe sur une base TOTALE répartie entre nEnfants (abattement /enfant)
function droitsLD(baseTotale, abattParEnfant, nEnfants) {
  const n = Math.max(1, nEnfants);
  const parEnfant = Math.max(0, baseTotale / n - abattParEnfant);
  return calculDroits(parEnfant, BAREME_LIGNE_DIRECTE) * n;
}

// -------------------------------------------------------------
// 1) Assurance-vie — plafonds 990 I & reventilation suggérée
// -------------------------------------------------------------
export function optimiserAV(state) {
  const D = debrief(state);
  const personnes = state.personnes || [];
  const enfants = personnes.filter((p) => p.role === "enfant");
  // Capital 990 I (primes avant 70) par bénéficiaire, déjà agrégé par debrief
  const parBenef = {};
  (D.avBeneficiaires || []).forEach((b) => { parBenef[b.nom] = (parBenef[b.nom] || 0) + (b.capital || 0); });

  // Seuil de capital où la taxation passe de 20 % à 31,25 % (990 I) :
  // abattement 152 500 € + 700 000 € de base à 20 % = 852 500 € de capital reçu.
  const SEUIL_3125 = PLAFOND_AV + AV_AVANT_70.seuilTranche1;

  // Lignes par bénéficiaire présent + enfants sans AV (capacité libre)
  const noms = new Set([...Object.keys(parBenef), ...enfants.map((e) => e.nom)]);
  const lignes = [...noms].map((nom) => {
    const capital = parBenef[nom] || 0;
    // Palier marginal actuel : franchise (≤152 500), 20 % (≤852 500), sinon 31,25 %
    const palier = capital <= PLAFOND_AV ? "franchise" : capital <= SEUIL_3125 ? "20" : "31.25";
    return {
      nom, capital,
      plafond: PLAFOND_AV,
      seuil3125: SEUIL_3125,
      palier,
      depassement: Math.max(0, capital - PLAFOND_AV),         // au-dessus de l'abattement (devient taxable)
      capaciteLibre: Math.max(0, PLAFOND_AV - capital),        // reste avant de commencer à taxer (20 %)
      capaciteAvant3125: Math.max(0, SEUIL_3125 - capital),    // reste avant de basculer à 31,25 % (« stop AV »)
      droits: droits990(capital),
      estHeritier: enfants.some((e) => e.nom === nom),
    };
  }).sort((a, b) => b.capital - a.capital);

  const droitsActuels = lignes.reduce((s, l) => s + l.droits, 0);

  // Cible = répartition optimale du capital 990 I total entre les enfants héritiers.
  // droits990 est convexe → la répartition égale minimise la somme des droits.
  const heirs = enfants.map((e) => e.nom);
  const capitalTotal = lignes.reduce((s, l) => s + l.capital, 0);
  let droitsCible = droitsActuels, perHead = 0;
  if (heirs.length) {
    perHead = capitalTotal / heirs.length;
    droitsCible = heirs.length * droits990(perHead);
  }
  const economie = Math.max(0, droitsActuels - droitsCible);

  // Suggestions concrètes : des saturés vers les héritiers à capacité libre
  const satures = lignes.filter((l) => l.depassement > 0);
  const libres = lignes.filter((l) => l.estHeritier && l.capaciteLibre > 0).sort((a, b) => b.capaciteLibre - a.capaciteLibre);
  const suggestions = [];
  if (economie > 0 && satures.length && libres.length) {
    satures.forEach((s) => {
      let reste = s.depassement;
      libres.forEach((l) => {
        if (reste <= 0 || l.capaciteLibre <= 0) return;
        const mv = Math.min(reste, l.capaciteLibre);
        suggestions.push(`Réorienter <b>${eurTxt(mv)}</b> de capital 990 I aujourd'hui destiné à <b>${s.nom}</b> (plafond saturé) vers un contrat au bénéfice de <b>${l.nom}</b> (plafond libre à ${eurTxt(l.capaciteLibre)}).`);
        reste -= mv; l.capaciteLibre -= mv;
      });
    });
  }
  return { lignes, droitsActuels, droitsCible, economie, perHead, suggestions, capitalTotal, nHeirs: heirs.length, plafond: PLAFOND_AV, seuil3125: SEUIL_3125 };
}

// Vue « après décès » : capital 990 I reçu par chaque enfant, VENTILÉ PAR ASSURÉ.
// Le plafond 152 500 € (abattement) PUIS 700 000 € à 20 % (bascule 31,25 % à 852 500 €)
// s'apprécie par COUPLE assuré → bénéficiaire : chaque parent ouvre un plafond distinct.
export function avParAssureEnfant(state, opts = {}) {
  // opts.supposeToutAuxEnfants (défaut true) : SCÉNARIO « rien n'est consommé » —
  // on suppose que le conjoint ne dépense rien et que TOUT finit chez les enfants.
  // Les contrats sans bénéficiaire renseigné sont alors répartis entre les enfants
  // (marqués « supposé enfants »), au lieu d'être laissés de côté.
  const supposeTout = opts.supposeToutAuxEnfants !== false;
  const personnes = state.personnes || [];
  const av = state.av || [];
  const enfants = personnes.filter((p) => p.role === "enfant");
  const estEnfant = (id) => enfants.some((e) => e.id === id);
  const nom = (id) => personnes.find((p) => p.id === id)?.nom || id;
  const legs = {}; // "assuré|enfantId" -> capital 990 I
  // Réconciliation avec le TOTAL des contrats saisis (pour ne rien masquer)
  let totalAvGlobal = 0, apres70 = 0, versAutres = 0, sansBeneficiaire = 0, supposeEnfants = 0;
  const tousEnfants = enfants.map((e) => e.id);
  const legInfo = {}; // "assuré|enfantId" -> { differe, suppose }
  av.forEach((a) => {
    const m = Number(a.montant) || 0;
    totalAvGlobal += m;
    if (!m) return;
    if (!avAvant70Effectif(a, personnes)) { apres70 += m; return; } // après 70 ans (757 B) : autre régime
    // Bénéficiaires FINAUX côté enfants :
    //  - clause « conjoint à défaut enfants » : le conjoint reçoit exonéré au 1er décès,
    //    puis les enfants « à défaut » au 2d → destination finale = enfants (reçu PLUS TARD).
    //  - clause désignée : liste telle quelle (enfants + éventuels autres).
    //  - sans bénéficiaire + scénario « tout aux enfants » : réparti entre les enfants (supposé).
    const differe = a.clauseType === "conjoint_defaut_enfants"; // reçu au 2d décès
    let bensAll = a.beneficiaires || [];
    let suppose = false;
    if (differe) {
      const kids = bensAll.filter(estEnfant);
      bensAll = kids.length ? kids : tousEnfants;
    }
    if (!bensAll.length) {
      if (supposeTout && tousEnfants.length) { bensAll = tousEnfants; suppose = true; supposeEnfants += m; }
      else { sansBeneficiaire += m; return; }
    }
    const rep = a.repartition || {};
    const tot = bensAll.reduce((s, b) => s + (Number(rep[b]) || 0), 0);
    const assure = a.cosouscripteurId ? `${nom(a.souscripteurId)} + ${nom(a.cosouscripteurId)}` : nom(a.souscripteurId);
    // Répartition sur TOUS les bénéficiaires ; on ne retient que les jambes vers les enfants,
    // le reste (conjoint/autres) est comptabilisé à part.
    bensAll.forEach((b) => {
      const share = tot > 0 ? (Number(rep[b]) || 0) / tot : 1 / bensAll.length;
      if (estEnfant(b)) {
        const key = `${assure}|${b}`;
        legs[key] = (legs[key] || 0) + m * share;
        (legInfo[key] ||= { differe: false, suppose: false });
        legInfo[key].differe = legInfo[key].differe || differe;
        legInfo[key].suppose = legInfo[key].suppose || suppose;
      } else versAutres += m * share;
    });
  });
  const seuil3125 = PLAFOND_AV + AV_AVANT_70.seuilTranche1;
  const rows = Object.entries(legs).map(([k, capital]) => {
    const [assure, benId] = k.split("|");
    const palier = capital <= PLAFOND_AV ? "franchise" : capital <= seuil3125 ? "20" : "31.25";
    return {
      assure, enfant: nom(benId), capital, palier,
      differe: !!(legInfo[k] && legInfo[k].differe),
      suppose: !!(legInfo[k] && legInfo[k].suppose),
      capaciteAvant3125: Math.max(0, seuil3125 - capital),
      droits: droits990(capital),
    };
  }).sort((a, b) => a.enfant.localeCompare(b.enfant) || b.capital - a.capital);
  const totalCouvert = rows.reduce((s, r) => s + r.capital, 0);
  // Récap par enfant (somme des jambes ; capacité restante = cumul des places à 20 % sur chaque jambe)
  const parEnfantMap = {};
  rows.forEach((r) => {
    (parEnfantMap[r.enfant] ||= { enfant: r.enfant, capital: 0, droits: 0, nbAssures: 0, capaciteAvant3125: 0 });
    parEnfantMap[r.enfant].capital += r.capital;
    parEnfantMap[r.enfant].droits += r.droits;
    parEnfantMap[r.enfant].nbAssures += 1;
    parEnfantMap[r.enfant].capaciteAvant3125 += r.capaciteAvant3125;
  });
  const parEnfant = Object.values(parEnfantMap).sort((a, b) => b.capital - a.capital);
  // Marge de manœuvre : combien peut-on ENCORE verser à 20 % (avant le palier 31,25 %),
  // agrégée par PARENT-ASSURÉ (le plafond s'ouvre par assuré, pas au niveau de l'enfant).
  const margeParAssureMap = {};
  rows.forEach((r) => {
    (margeParAssureMap[r.assure] ||= { assure: r.assure, capital: 0, marge: 0 });
    margeParAssureMap[r.assure].capital += r.capital;
    margeParAssureMap[r.assure].marge += r.capaciteAvant3125;
  });
  const margeParAssure = Object.values(margeParAssureMap).sort((a, b) => b.marge - a.marge);
  const margeTotale = rows.reduce((s, r) => s + r.capaciteAvant3125, 0);
  const totalDroits = rows.reduce((s, r) => s + r.droits, 0);
  return { rows, parEnfant, seuil3125, plafond: PLAFOND_AV, totalAvGlobal, totalCouvert, apres70, versAutres, sansBeneficiaire, supposeEnfants, margeParAssure, margeTotale, totalDroits };
}

// Comparateur fiscal d'un CONTRAT DE CAPITALISATION : donation NP démembrée (A)
// vs donation pleine propriété (B) vs succession (C). Coût total = droits de
// mutation + IR + PS au rachat de l'enfant → net final. Règles BOI-RPPM-RCM-
// 20-10-20-50 §225 : base IR = NP à la donation (A, purge partielle), valeur pleine
// à la donation (B, purge totale), valeur au décès (C, step-up succession).
const PS_RATE = 0.172, SEUIL_PRIMES = 150000, TAUX_REDUIT = 0.075, TAUX_PFU = 0.128;
function impotRachatCapi(gain, ageContrat, primes, primesAvant2017, useBareme, tmi, couple) {
  if (gain <= 0) return { ir: 0, ps: 0 };
  const ps = gain * PS_RATE;
  const abatt = ageContrat >= 8 ? (couple ? 9200 : 4600) : 0;
  const gainIr = Math.max(0, gain - abatt);
  let ir;
  if (useBareme) ir = gainIr * tmi;
  else if (ageContrat >= 8) {
    let taux;
    if (primesAvant2017 || primes <= SEUIL_PRIMES) taux = TAUX_REDUIT;
    else { const f = SEUIL_PRIMES / primes; taux = TAUX_REDUIT * f + TAUX_PFU * (1 - f); }
    ir = gainIr * taux;
  } else ir = gainIr * TAUX_PFU;
  return { ir: Math.round(ir), ps: Math.round(ps) };
}
export function comparerCapitalisation(actif, p) {
  const r = 1 + (Number(p.rendement) || 0);
  const vDon = Number(actif.valeurNette) || 0;          // valeur aujourd'hui = référence donation
  const primes = Number(p.primes) || vDon;              // proxy si primes inconnues
  const vDeces = vDon * Math.pow(r, p.anneesDonDeces);
  const vRachat = vDeces * Math.pow(r, p.anneesDecesRachat);
  const ageContrat = (Number(p.ageContratActuel) || 0) + p.anneesDonDeces + p.anneesDecesRachat;
  const npFrac = 1 - tauxUsufruit(p.ageDonateur);
  const abattDon = p.abattementDonation != null ? p.abattementDonation : ABATTEMENTS.enfant;
  const dmtg = (base) => calculDroits(Math.max(0, base - abattDon), BAREME_LIGNE_DIRECTE);
  const tax = (gain) => impotRachatCapi(gain, ageContrat, primes, p.primesAvant2017, p.useBareme, p.tmi, p.couple);
  const build = (nom, droits, baseIr, note) => {
    const t = tax(Math.max(0, vRachat - baseIr));
    return { nom, droits, ir: t.ir, ps: t.ps, total: droits + t.ir + t.ps, netEnfant: Math.round(vRachat - droits - t.ir - t.ps), baseIr, note };
  };
  const vNpDon = vDon * npFrac;
  const A = build("A · Donation NP (démembrée)", dmtg(vNpDon), vNpDon, "base IR = NP à la donation (prudent §225)");
  const B = build("B · Donation pleine propriété", dmtg(vDon), vDon, "purge totale à la valeur du jour");
  const C = build("C · Succession (rien)", dmtg(vDeces), vDeces, "step-up : base IR = valeur au décès");
  const rows = [A, B, C];
  const best = rows.reduce((a, b) => (b.netEnfant > a.netEnfant ? b : a)).nom;
  // Incertitude §225 sur la stratégie A : borne le net selon la base retenue
  const incert = [
    { base: "NP à la donation (prudent)", net: A.netEnfant },
    { base: "PP à la donation", net: Math.round(vRachat - A.droits - tax(Math.max(0, vRachat - vDon)).ir - tax(Math.max(0, vRachat - vDon)).ps) },
    { base: "valeur au décès (step-up)", net: Math.round(vRachat - A.droits - tax(Math.max(0, vRachat - vDeces)).ir - tax(Math.max(0, vRachat - vDeces)).ps) },
  ];
  return { rows, best, vDon, vDeces, vRachat, npFrac, incert };
}

// -------------------------------------------------------------
// 2) Démembrement — donner la NP maintenant vs attendre 15 ans vs succession
//    actif : { libelle, valeurNette, dutreil }
//    params: { revaloPct, esperance, ageParent, nbParents, nbEnfants,
//              abattParEnfantNow, fractionAOffrir }
// -------------------------------------------------------------
export function arbitrageDemembrement(actif, p) {
  const revalo = 1 + (Number(p.revaloPct) || 0) / 100;
  const frac = Math.min(1, Math.max(0, Number(p.fractionAOffrir) || 1));
  const dutreilFactor = actif.dutreil ? 0.25 : 1; // −75 % d'assiette si pacte
  const nEnf = Math.max(1, p.nbEnfants || 1);
  const abattFrais = ABATTEMENTS.enfant * Math.max(1, p.nbParents || 1); // rechargé /enfant
  const abattNow = p.abattParEnfantNow != null ? p.abattParEnfantNow : abattFrais;
  const abattWait = p.abattParEnfantWait != null ? p.abattParEnfantWait : abattFrais;
  // Horizon d'attente = délai avant que l'abattement se RECHARGE (dépend de quand/quoi
  // a déjà été donné), PAS 15 ans en dur. 0 si l'abattement est déjà disponible.
  const horizon = p.horizonAns != null ? Math.max(0, Number(p.horizonAns)) : DELAI_RAPPEL_ANS;

  // Valeur NETTE à un horizon h : le BRUT est revalorisé, mais la DETTE est AMORTIE
  // (capital restant dû qui baisse) → la valeur nette taxable grimpe doublement.
  const brut0 = Number(actif.valeurBrute) || Number(actif.valeurNette) || 0;
  const dette0 = Number(actif.dette) || 0;
  const dureePret = p.dureePretAns != null ? Math.max(0, Number(p.dureePretAns)) : 0;
  const netA = (h) => {
    const brut = brut0 * Math.pow(revalo, h);
    const dette = dureePret > 0 ? dette0 * Math.max(0, 1 - h / dureePret) : dette0; // amortissement linéaire
    return { net: Math.max(0, brut - dette), brut, dette };
  };

  // MAINTENANT — donation de la nue-propriété (le parent garde l'usufruit/contrôle)
  const n0 = netA(0);
  const npNow = 1 - tauxUsufruit(p.ageParent);
  const offerteNow = n0.net * frac;
  const baseNow = offerteNow * npNow * dutreilFactor;
  const droitsNow = droitsLD(baseNow, abattNow, nEnf);

  // ATTENDRE LA RECHARGE — bien revalorisé + dette amortie sur l'horizon, parent plus
  // âgé (NP plus grosse), mais abattement rechargé (100 000 €/parent/enfant à nouveau libre).
  const ageWait = p.ageParent + horizon;
  const nW = netA(horizon);
  const npFut = 1 - tauxUsufruit(ageWait);
  const offerteFut = nW.net * frac;
  const baseFut = offerteFut * npFut * dutreilFactor;
  const droitsWait = droitsLD(baseFut, abattWait, nEnf);
  const risqueDeces = p.esperance != null && ageWait > p.esperance;

  // NE RIEN FAIRE — succession à l'espérance de vie : PLEINE valeur nette revalorisée
  // (dette quasi soldée), taxée en pleine propriété. L'abattement retenu est celui
  // DISPONIBLE À LA DATE DU DÉCÈS (abattParEnfantSucc, connecté au délai de recharge) :
  // plein si le décès survient après la recharge, partiel s'il survient avant.
  const anneesDeces = Math.max(0, (p.esperance || p.ageParent) - p.ageParent);
  const abattSucc = p.abattParEnfantSucc != null ? p.abattParEnfantSucc : abattFrais;
  const nD = netA(anneesDeces);
  const valeurDeces = nD.net * frac;
  const baseDeces = valeurDeces * dutreilFactor;
  const droitsDeces = droitsLD(baseDeces, abattSucc, nEnf);

  const scores = { maintenant: droitsNow, attendre: droitsWait, succession: droitsDeces };
  const best = Object.keys(scores).reduce((a, b) => (scores[a] <= scores[b] ? a : b));

  // Purge par tranches : combien d'opérations de 15 ans pour tout transmettre
  const ops = frac > 0 ? Math.ceil(1 / frac) : 0;

  return {
    actif: { libelle: actif.libelle, valeurNette: n0.net, dutreil: actif.dutreil },
    frac, horizon,
    maintenant: { valeurOfferte: offerteNow, npFrac: npNow, base: baseNow, droits: droitsNow, net: offerteNow - droitsNow, abatt: abattNow, age: p.ageParent, valeurNette: n0.net, dette: n0.dette },
    attendre: { valeurOfferte: offerteFut, npFrac: npFut, base: baseFut, droits: droitsWait, net: offerteFut - droitsWait, valeurNette: nW.net, valeurBrute: nW.brut, dette: nW.dette, risqueDeces, abatt: abattWait, age: ageWait, horizon },
    succession: { valeur: valeurDeces, base: baseDeces, droits: droitsDeces, net: valeurDeces - droitsDeces, abatt: abattSucc, valeurNette: nD.net, dette: nD.dette, anneesDeces },
    best,
    deltaAttendreVsMaintenant: droitsWait - droitsNow,
    deltaMaintenantVsSuccession: droitsDeces - droitsNow,
    tranches: { ops, fraction: frac },
  };
}

// Abattement MOYEN encore disponible par enfant à une date future (now + horizonAns),
// en tenant compte de TOUTES les donations déjà faites (effet cumulé) : un don n'est
// « purgé » à cette date future que s'il a alors plus de 15 ans.
export function abattementMoyenADate(state, horizonAns = 0) {
  const personnes = state.personnes || [];
  const donations = state.donations || [];
  const enfants = personnes.filter((p) => p.role === "enfant");
  const nbParents = Math.max(1, personnes.filter((p) => p.role === "parent").length);
  const plafond = ABATTEMENTS.enfant * nbParents;
  if (!enfants.length) return plafond;
  const anneeActuelle = new Date().getFullYear();
  const cut = anneeActuelle + (Number(horizonAns) || 0) - DELAI_RAPPEL_ANS; // dons d'année ≤ cut = purgés à l'horizon
  const dispo = enfants.map((e) => {
    const consomme = donations
      .filter((d) => d.beneficiaireId === e.id && new Date(d.date).getFullYear() > cut)
      .reduce((s, d) => s + (Number(d.montant) || 0), 0);
    return Math.max(0, plafond - consomme);
  });
  return dispo.reduce((s, x) => s + x, 0) / dispo.length;
}

// Délai (années) avant recharge COMPLÈTE de l'abattement = 15 ans après la donation
// la plus RÉCENTE encore dans le rappel fiscal (0 si aucun don < 15 ans → déjà plein).
export function horizonRechargePleine(state) {
  const personnes = state.personnes || [];
  const donations = state.donations || [];
  const anneeActuelle = new Date().getFullYear();
  let maxAnneePurge = 0;
  donations.forEach((d) => {
    const an = new Date(d.date).getFullYear();
    if (anneeActuelle - an < DELAI_RAPPEL_ANS) maxAnneePurge = Math.max(maxAnneePurge, an + DELAI_RAPPEL_ANS);
  });
  return maxAnneePurge ? Math.max(0, maxAnneePurge - anneeActuelle) : 0;
}

// -------------------------------------------------------------
// 3) Timing des donations — abattement dispo & prochaine recharge
// -------------------------------------------------------------
export function timingDonations(state) {
  const D = debrief(state);
  const donations = state.donations || [];
  const personnes = state.personnes || [];
  const nom = (id) => personnes.find((p) => p.id === id)?.nom || id;
  const anneesEcoulees = (d) => (new Date() - new Date(d)) / (365.25 * 864e5);

  // Prochaine recharge par couple (donateur→bénéficiaire) = don le plus ANCIEN < 15 ans + 15 ans
  const rechargeParCouple = {};
  donations.forEach((d) => {
    const ecoule = anneesEcoulees(d.date);
    if (ecoule >= DELAI_RAPPEL_ANS) return;
    const key = `${nom(d.donateurId)}→${nom(d.beneficiaireId)}`;
    const an = new Date(d.date).getFullYear() + DELAI_RAPPEL_ANS;
    if (!rechargeParCouple[key] || an < rechargeParCouple[key]) rechargeParCouple[key] = an;
  });

  const rows = (D.abatt || []).map((a) => {
    const key = `${a.parent}→${a.enfant}`;
    return {
      parent: a.parent, enfant: a.enfant,
      consomme: a.consomme, restant: a.restant,
      prochaineRecharge: rechargeParCouple[key] || null, // null = abattement plein, dispo tout de suite
    };
  }).sort((x, y) => y.restant - x.restant);

  return { rows, capaciteExoneree: D.capaciteExoneree };
}

// -------------------------------------------------------------
// 4) Synthèse — cockpit : droits aujourd'hui + leviers classés
// -------------------------------------------------------------
export function syntheseOptim(state, params = {}) {
  const D = debrief(state);
  const av = optimiserAV(state);

  // Levier démembrement : gain total si TOUS les biens PP parents sont démembrés
  // maintenant (donation NP) plutôt que laissés à la succession. Import différé
  // pour éviter la dépendance circulaire dure au chargement.
  const leviers = [];
  if (av.economie > 0)
    leviers.push({ nom: "Reventiler les bénéficiaires d'assurance-vie", economie: av.economie });

  return {
    droitsAujourdhui: D.totalDroitsTous || 0,
    capaciteExoneree: D.capaciteExoneree || 0,
    leviers, // le levier démembrement (dépend des curseurs) est ajouté côté UI
    av,
  };
}

// util local (formatage euro pour les suggestions HTML)
function eurTxt(n) { return Math.round(n || 0).toLocaleString("fr-FR") + " €"; }
