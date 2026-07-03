// =============================================================
//  Données de référence fiscales — France
//  Barèmes valables 2026 (à vérifier chaque année en LFI)
//  Source : CGI art. 777, 779, 669, 790 G, 990 I, 757 B
// =============================================================

// Barème des droits de mutation à titre gratuit — LIGNE DIRECTE
// (donations ET successions parents <-> enfants : même barème)
// Tranches sur la part nette taxable APRÈS abattement.
export const BAREME_LIGNE_DIRECTE = [
  { plafond: 8072,     taux: 0.05 },
  { plafond: 12109,    taux: 0.10 },
  { plafond: 15932,    taux: 0.15 },
  { plafond: 552324,   taux: 0.20 },
  { plafond: 902838,   taux: 0.30 },
  { plafond: 1805677,  taux: 0.40 },
  { plafond: Infinity, taux: 0.45 },
];

// Barème entre époux / partenaires PACS (successions exonérées,
// mais donations entre époux restent taxées selon ce barème)
export const BAREME_EPOUX = [
  { plafond: 8072,     taux: 0.05 },
  { plafond: 15932,    taux: 0.10 },
  { plafond: 31865,    taux: 0.15 },
  { plafond: 552324,   taux: 0.20 },
  { plafond: 902838,   taux: 0.30 },
  { plafond: 1805677,  taux: 0.40 },
  { plafond: Infinity, taux: 0.45 },
];

// Barème frères / sœurs
export const BAREME_FRERES_SOEURS = [
  { plafond: 24430,    taux: 0.35 },
  { plafond: Infinity, taux: 0.45 },
];

// Abattements (par donateur -> bénéficiaire, renouvelables /15 ans)
export const ABATTEMENTS = {
  enfant:        100000, // art. 779 I : parent -> enfant
  epoux_pacs:    80724,  // donations entre époux/pacs
  petit_enfant:  31865,
  arriere_pt_enf: 5310,
  frere_soeur:   15932,
  neveu_niece:   7967,
  handicap:      159325, // cumulable, art. 779 II
  defaut:        1594,   // absence de lien / lointain
};

// Don familial de somme d'argent — art. 790 G (EN PLUS de l'abattement)
// Conditions : donateur < 80 ans ET bénéficiaire majeur. /15 ans.
export const DON_FAMILIAL_SOMME = 31865;

// Durée du rappel fiscal (délai de rechargement des abattements)
export const DELAI_RAPPEL_ANS = 15;

// Barème de l'usufruit / nue-propriété — art. 669 CGI
// Fonction de l'âge de l'USUFRUITIER au jour de la donation/succession.
// usufruit = % de la valeur en pleine propriété ; NP = 100 - usufruit.
export const BAREME_USUFRUIT = [
  { ageMax: 20, usufruit: 0.90 }, // jusqu'à 21 ans révolus
  { ageMax: 30, usufruit: 0.80 },
  { ageMax: 40, usufruit: 0.70 },
  { ageMax: 50, usufruit: 0.60 },
  { ageMax: 60, usufruit: 0.50 },
  { ageMax: 70, usufruit: 0.40 },
  { ageMax: 80, usufruit: 0.30 },
  { ageMax: 90, usufruit: 0.20 },
  { ageMax: 999, usufruit: 0.10 }, // 91 ans et plus
];

// Assurance-vie
// Primes versées AVANT 70 ans — art. 990 I
export const AV_AVANT_70 = {
  abattement: 152500,        // par bénéficiaire
  tauxTranche1: 0.20,        // jusqu'à 700 000 € après abattement
  seuilTranche1: 700000,
  tauxTranche2: 0.3125,      // au-delà
};
// Primes versées APRÈS 70 ans — art. 757 B
export const AV_APRES_70 = {
  abattementGlobal: 30500,   // global, tous bénéficiaires confondus
  // au-delà : les PRIMES (pas les gains) réintègrent l'actif successoral
};

// Renvoie le % d'usufruit selon l'âge de l'usufruitier (art. 669)
export function tauxUsufruit(age) {
  const t = BAREME_USUFRUIT.find((b) => age <= b.ageMax);
  return t ? t.usufruit : 0.10;
}

// Calcule les droits selon un barème progressif sur une base taxable
export function calculDroits(baseTaxable, bareme) {
  if (baseTaxable <= 0) return 0;
  let droits = 0;
  let bas = 0;
  for (const tranche of bareme) {
    if (baseTaxable > bas) {
      const hautTranche = Math.min(baseTaxable, tranche.plafond);
      droits += (hautTranche - bas) * tranche.taux;
      bas = tranche.plafond;
    } else break;
  }
  return Math.round(droits);
}

export const BAREMES_PAR_LIEN = {
  enfant: BAREME_LIGNE_DIRECTE,
  petit_enfant: BAREME_LIGNE_DIRECTE,
  arriere_pt_enf: BAREME_LIGNE_DIRECTE,
  epoux_pacs: BAREME_EPOUX,
  frere_soeur: BAREME_FRERES_SOEURS,
  defaut: [{ plafond: Infinity, taux: 0.60 }],
};

export const LIBELLE_LIEN = {
  enfant: "Enfant",
  petit_enfant: "Petit-enfant",
  arriere_pt_enf: "Arrière-petit-enfant",
  epoux_pacs: "Époux / PACS",
  frere_soeur: "Frère / Sœur",
  neveu_niece: "Neveu / Nièce",
  handicap: "Personne handicapée",
  defaut: "Autre / sans lien",
};
