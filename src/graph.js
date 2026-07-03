// =============================================================
//  Organigramme (Mermaid) + Débrief patrimonial
// =============================================================
import { ABATTEMENTS, DELAI_RAPPEL_ANS, AV_AVANT_70, AV_APRES_70, calculDroits, BAREME_LIGNE_DIRECTE } from "./data.js";

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
    else if (a.categorie === "entreprise") L.push(`  ${a.id}[["🏭 ${lbl}"]]:::entreprise`);
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
    (a.beneficiaires || []).forEach((b) => L.push(`  ${a.id} -.->|bénéf.| ${b}`));
  });

  // Donations (arêtes épaisses avec montant + date)
  state.donations.forEach((d) => {
    const an = new Date(d.date).getFullYear() || "";
    L.push(`  ${d.donateurId} ==>|"🎁 ${eur0(d.montant)} (${an})"| ${d.beneficiaireId}`);
  });

  // Styles
  L.push("  classDef parent fill:#1e3a5f,stroke:#4ea1ff,color:#e7eef5;");
  L.push("  classDef enfant fill:#243b2e,stroke:#2ecc9b,color:#e7eef5;");
  L.push("  classDef sci fill:#3a2f1e,stroke:#f0a03c,color:#fff;");
  L.push("  classDef immo fill:#2a2440,stroke:#a78bfa,color:#fff;");
  L.push("  classDef entreprise fill:#3a2438,stroke:#e879c9,color:#fff;");
  L.push("  classDef cash fill:#1e3535,stroke:#2ecc9b,color:#fff;");
  L.push("  classDef titres fill:#2a2440,stroke:#7aa2f7,color:#fff;");
  L.push("  classDef av fill:#3a1e2e,stroke:#f472b6,color:#fff;");
  L.push("  classDef autre fill:#222c36,stroke:#5a6b7b,color:#fff;");
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
  const actif = (id) => actifs.find((a) => a.id === id);
  const estPersonne = (id) => personnes.some((p) => p.id === id);

  // Patrimoine détenu par les personnes (les biens logés dans une SCI ne
  // sont PAS recomptés : les personnes détiennent les parts de SCI).
  const parPersonne = {};
  personnes.forEach((p) => (parPersonne[p.id] = 0));
  let patrimoineFoyer = 0;
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return; // détenu par une SCI -> ignoré au niveau foyer
    const a = actif(d.actifRef);
    if (!a) return;
    const val = (a.valeur * d.part) / 100;
    parPersonne[d.proprietaire] += val;
    patrimoineFoyer += val;
  });

  // Répartition par catégorie
  const parCategorie = {};
  detentions.forEach((d) => {
    if (!estPersonne(d.proprietaire)) return;
    const a = actif(d.actifRef);
    if (!a) return;
    parCategorie[a.categorie] = (parCategorie[a.categorie] || 0) + (a.valeur * d.part) / 100;
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

  // « Si décès aujourd'hui » — détail par enfant.
  // Hypothèse simple : patrimoine réparti également entre les enfants, chaque
  // enfant bénéficiant d'un abattement de 100 000 € par parent (art. 779),
  // diminué des donations déjà consenties dans les 15 ans (rappel fiscal).
  let droitsSuccessionEstimes = 0;
  const successionParEnfant = [];
  const partParEnfant = enfants.length ? patrimoineFoyer / enfants.length : 0;
  enfants.forEach((enf) => {
    const consomme = donations
      .filter((d) => d.beneficiaireId === enf.id && anneesEcoulees(d.date) < DELAI_RAPPEL_ANS)
      .reduce((s, d) => s + d.montant, 0);
    const abattementDispo = Math.max(0, ABATTEMENTS.enfant * parents.length - consomme);
    const base = Math.max(0, partParEnfant - abattementDispo);
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

  return {
    patrimoineFoyer,
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
