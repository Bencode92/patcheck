// =============================================================
//  Import / export CSV — un seul fichier "propre"
//  Une ligne = un élément, discriminé par la colonne `type`.
// =============================================================

export const COLUMNS = [
  "type", "id", "libelle", "role", "naissance", "categorie", "valeur",
  "proprietaire", "actif_ref", "part_pct", "droit", "beneficiaire",
  "date", "montant", "avant_70", "note", "dutreil",
];

// Modèle vierge documenté (avec exemples réalistes à remplacer)
export const TEMPLATE_ROWS = [
  ["# type", "id", "libelle", "role", "naissance", "categorie", "valeur", "proprietaire", "actif_ref", "part_pct", "droit", "beneficiaire", "date", "montant", "avant_70", "note", "dutreil"],
  ["personne", "P1", "Jean Dupont", "parent", "1958-04-12", "", "", "", "", "", "", "", "", "", "", "père"],
  ["personne", "P2", "Anne Dupont", "parent", "1961-09-03", "", "", "", "", "", "", "", "", "", "", "mère"],
  ["personne", "E1", "Marie", "enfant", "1988-01-20", "", "", "", "", "", "", "", "", "", "", ""],
  ["personne", "E2", "Paul", "enfant", "1991-06-15", "", "", "", "", "", "", "", "", "", "", ""],
  ["personne", "E3", "Léa", "enfant", "1995-11-02", "", "", "", "", "", "", "", "", "", "", ""],
  ["actif", "SCI1", "SCI Familiale", "", "", "sci", "900000", "", "", "", "", "", "", "", "", "détient l'immeuble locatif"],
  ["actif", "B1", "Résidence principale", "", "", "immobilier", "550000", "", "", "", "", "", "", "", "", ""],
  ["actif", "B2", "Immeuble locatif", "", "", "immobilier", "900000", "", "", "", "", "", "", "", "", "logé dans la SCI"],
  ["actif", "C1", "Comptes & liquidités", "", "", "liquidites", "120000", "", "", "", "", "", "", "", "", ""],
  ["actif", "T1", "Portefeuille titres", "", "", "titres", "180000", "", "", "", "", "", "", "", "", ""],
  ["actif", "ENT1", "Parts société (capital entreprise)", "", "", "entreprise", "600000", "", "", "", "", "", "", "", "", "pacte Dutreil", "oui"],
  ["detention", "", "", "", "", "", "", "P1", "ENT1", "100", "PP", "", "", "", "", "dirigeant", ""],
  ["detention", "", "", "", "", "", "", "P1", "SCI1", "50", "PP", "", "", "", "", "Jean 50% pleine propriété"],
  ["detention", "", "", "", "", "", "", "P2", "SCI1", "20", "PP", "", "", "", "", ""],
  ["detention", "", "", "", "", "", "", "P1", "SCI1", "10", "US", "", "", "", "", "usufruit conservé"],
  ["detention", "", "", "", "", "", "", "E1", "SCI1", "10", "NP", "", "", "", "", "nue-propriété donnée"],
  ["detention", "", "", "", "", "", "", "E2", "SCI1", "10", "NP", "", "", "", "", ""],
  ["detention", "", "", "", "", "", "", "SCI1", "B2", "100", "PP", "", "", "", "", "l'immeuble appartient à la SCI"],
  ["detention", "", "", "", "", "", "", "P1", "B1", "50", "PP", "", "", "", "", ""],
  ["detention", "", "", "", "", "", "", "P2", "B1", "50", "PP", "", "", "", "", ""],
  ["detention", "", "", "", "", "", "", "P1", "C1", "50", "PP", "", "", "", "", ""],
  ["detention", "", "", "", "", "", "", "P2", "C1", "50", "PP", "", "", "", "", ""],
  ["donation", "", "", "", "", "", "", "P1", "", "", "", "E1", "2019-05-01", "100000", "", "donation parts SCI (NP)"],
  ["donation", "", "", "", "", "", "", "P2", "", "", "", "E2", "2015-03-10", "80000", "", ""],
  ["av", "AV1", "Contrat AV Jean", "", "", "", "250000", "P1", "", "", "", "E1;E2;E3", "", "", "oui", "primes avant 70 ans"],
  ["av", "AV2", "Contrat AV Anne", "", "", "", "160000", "P2", "", "", "", "E1;E2;E3", "", "", "non", "primes après 70 ans"],
];

// --- Sérialisation ---
function esc(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function templateCSV() {
  return TEMPLATE_ROWS.map((r) => r.map(esc).join(",")).join("\n");
}

export function stateToCSV(state) {
  const rows = [COLUMNS];
  const push = (o) => rows.push(COLUMNS.map((c) => o[c] ?? ""));

  state.personnes.forEach((p) =>
    push({ type: "personne", id: p.id, libelle: p.nom, role: p.role, naissance: p.naissance })
  );
  (state.actifs || []).forEach((a) =>
    push({ type: "actif", id: a.id, libelle: a.libelle, categorie: a.categorie, valeur: a.valeur, dutreil: a.dutreil ? "oui" : "" })
  );
  (state.detentions || []).forEach((d) =>
    push({ type: "detention", proprietaire: d.proprietaire, actif_ref: d.actifRef, part_pct: d.part, droit: d.droit, note: d.note })
  );
  state.donations.forEach((d) =>
    push({ type: "donation", proprietaire: d.donateurId, beneficiaire: d.beneficiaireId, date: d.date, montant: d.montant, note: d.note })
  );
  (state.av || []).forEach((a) =>
    push({ type: "av", id: a.id, libelle: a.libelle, valeur: a.montant, proprietaire: a.souscripteurId, beneficiaire: (a.beneficiaires || []).join(";"), avant_70: a.avant70 ? "oui" : "non", note: a.note })
  );
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

// --- Parsing (petit parseur CSV tolérant guillemets) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((x) => x !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function csvToState(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("CSV vide");
  // Détermine l'index des colonnes depuis l'entête (tolère un '#' devant type)
  const header = rows[0].map((h) => h.trim().replace(/^#\s*/, "").toLowerCase());
  const idx = {};
  COLUMNS.forEach((c) => (idx[c] = header.indexOf(c)));
  const get = (r, c) => (idx[c] >= 0 ? (r[idx[c]] ?? "").trim() : "");

  const st = { personnes: [], actifs: [], detentions: [], donations: [], av: [] };
  const num = (v) => Number(String(v).replace(/[^\d.-]/g, "")) || 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = get(r, "type").toLowerCase();
    if (!type || type.startsWith("#")) continue;
    switch (type) {
      case "personne":
        st.personnes.push({ id: get(r, "id") || uid(), nom: get(r, "libelle"), role: get(r, "role") || "enfant", naissance: get(r, "naissance") });
        break;
      case "actif":
        st.actifs.push({ id: get(r, "id") || uid(), libelle: get(r, "libelle"), categorie: get(r, "categorie") || "autre", valeur: num(get(r, "valeur")), dutreil: /oui|1|true/i.test(get(r, "dutreil")) });
        break;
      case "detention":
        st.detentions.push({ proprietaire: get(r, "proprietaire"), actifRef: get(r, "actif_ref"), part: num(get(r, "part_pct")), droit: (get(r, "droit") || "PP").toUpperCase(), note: get(r, "note") });
        break;
      case "donation":
        st.donations.push({ id: uid(), donateurId: get(r, "proprietaire"), beneficiaireId: get(r, "beneficiaire"), date: get(r, "date"), montant: num(get(r, "montant")), nature: "pleine", lien: "enfant", note: get(r, "note") });
        break;
      case "av":
        st.av.push({ id: get(r, "id") || uid(), libelle: get(r, "libelle"), souscripteurId: get(r, "proprietaire"), montant: num(get(r, "valeur")), beneficiaires: get(r, "beneficiaire").split(/[;|]/).map((s) => s.trim()).filter(Boolean), avant70: /oui|1|true|avant/i.test(get(r, "avant_70")), note: get(r, "note") });
        break;
      default:
        break; // ligne inconnue ignorée
    }
  }
  if (!st.personnes.length) throw new Error("Aucune personne trouvée dans le CSV.");
  return st;
}
