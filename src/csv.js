// =============================================================
//  Import / export CSV — format SECTIONNÉ et lisible.
//  Un bloc "# SECTION" par type d'élément, avec ses seules colonnes
//  utiles. Les références sont affichées par NOM (lisible) + id (ré-import
//  fiable). Rétrocompatible avec l'ancien format plat (colonne `type`).
// =============================================================

// Colonnes de l'ANCIEN format plat (conservées pour l'import rétrocompatible)
export const COLUMNS = [
  "type", "id", "libelle", "role", "naissance", "categorie", "valeur",
  "proprietaire", "actif_ref", "part_pct", "droit", "beneficiaire",
  "date", "montant", "avant_70", "note", "dutreil",
];

// --- Sérialisation ---
function esc(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const uid = () => Math.random().toString(36).slice(2, 10);

// Modèle vierge (format sectionné, avec exemples à remplacer)
export function templateCSV() {
  return [
    "# PERSONNES",
    "id,nom,role,naissance",
    "P1,Jean Dupont,parent,1958-04-12",
    "P2,Anne Dupont,parent,1961-09-03",
    "E1,Marie,enfant,1988-01-20",
    "",
    "# ACTIFS",
    "id,libelle,categorie,valeur,dutreil,annee_demembrement",
    "B1,Résidence principale,immobilier,550000,,",
    "SCI1,SCI Familiale,sci,900000,,",
    "ENT1,Parts société,entreprise,600000,oui,2025",
    "",
    "# DETENTIONS",
    "detenteur,detenteur_id,actif,actif_id,part_pct,droit",
    "Jean Dupont,P1,Résidence principale,B1,50,PP",
    "Anne Dupont,P2,Résidence principale,B1,50,PP",
    "Jean Dupont,P1,Parts société,ENT1,51,PP",
    "Marie,E1,Parts société,ENT1,49,NP",
    "",
    "# DETTES",
    "id,libelle,montant,adosse_a,adosse_a_id",
    "DET1,Emprunt SCI,300000,SCI Familiale,SCI1",
    "",
    "# DONATIONS",
    "donateur,donateur_id,beneficiaire,beneficiaire_id,date,montant,note",
    "Jean Dupont,P1,Marie,E1,2019-05-01,100000,donation NP",
    "",
    "# ASSURANCE-VIE",
    "id,libelle,etablissement,souscripteur,souscripteur_id,capital,regime,per,clause,beneficiaires",
    "AV1,Contrat AV Jean,Generali,Jean Dupont,P1,250000,avant 70 ans,,conjoint_defaut_enfants,Marie",
  ].join("\n");
}

export function stateToCSV(state) {
  const nameOf = (id) => {
    const p = (state.personnes || []).find((x) => x.id === id);
    if (p) return p.nom;
    const a = (state.actifs || []).find((x) => x.id === id);
    if (a) return a.libelle;
    return id || "";
  };
  const L = [];
  const section = (title, header, rows) => {
    L.push("# " + title);
    L.push(header.join(","));
    rows.forEach((r) => L.push(r.map(esc).join(",")));
    L.push(""); // ligne vide de séparation
  };

  section("PERSONNES", ["id", "nom", "role", "naissance"],
    (state.personnes || []).map((p) => [p.id, p.nom, p.role, p.naissance || ""]));

  section("ACTIFS", ["id", "libelle", "categorie", "valeur", "dutreil", "annee_demembrement"],
    (state.actifs || []).map((a) => [a.id, a.libelle, a.categorie, a.valeur, a.dutreil ? "oui" : "", a.demembrementAnnee || ""]));

  section("DETENTIONS", ["detenteur", "detenteur_id", "actif", "actif_id", "part_pct", "droit"],
    (state.detentions || []).map((d) => [nameOf(d.proprietaire), d.proprietaire, nameOf(d.actifRef), d.actifRef, d.part, d.droit]));

  section("DETTES", ["id", "libelle", "montant", "adosse_a", "adosse_a_id"],
    (state.dettes || []).map((x) => [x.id, x.libelle, x.montant, nameOf(x.cible), x.cible]));

  section("DONATIONS", ["donateur", "donateur_id", "beneficiaire", "beneficiaire_id", "date", "montant", "note"],
    (state.donations || []).map((d) => [nameOf(d.donateurId), d.donateurId, nameOf(d.beneficiaireId), d.beneficiaireId, d.date, d.montant, d.note || ""]));

  section("ASSURANCE-VIE", ["id", "libelle", "etablissement", "souscripteur", "souscripteur_id", "capital", "regime", "per", "clause", "beneficiaires"],
    (state.av || []).map((a) => [a.id, a.libelle, a.etablissement || "", nameOf(a.souscripteurId), a.souscripteurId, a.montant, a.avant70 ? "avant 70 ans" : "apres 70 ans", a.per ? "oui" : "", a.clauseType || "designe", (a.beneficiaires || []).map(nameOf).join(";")]));

  if (state.regime) section("REGIME", ["regime"], [[state.regime]]);

  return L.join("\n").replace(/\n+$/, "") + "\n";
}

// --- Parsing (petit parseur CSV tolérant guillemets) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
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

const num = (v) => Number(String(v).replace(/[^\d.-]/g, "")) || 0;
const yes = (v) => /oui|1|true/i.test(String(v || ""));
const noAccent = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function csvToState(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("CSV vide");
  const firstHeader = rows[0].map((h) => noAccent(h).trim().replace(/^#\s*/, "").toLowerCase());
  // Ancien format plat : la 1re ligne est un entête contenant la colonne "type"
  if (firstHeader.includes("type")) return csvToStateFlat(rows);
  return csvToStateSectioned(rows);
}

function csvToStateSectioned(rows) {
  const st = { personnes: [], actifs: [], detentions: [], dettes: [], donations: [], av: [] };
  const persByName = {}, actByName = {};
  let section = null, hdr = null;
  const col = (r, name) => { const j = hdr ? hdr.indexOf(name) : -1; return j >= 0 ? String(r[j] ?? "").trim() : ""; };
  const resolve = (name, map) => map[name.toLowerCase()] || "";

  for (const r of rows) {
    const first = String(r[0] ?? "").trim();
    if (first.startsWith("#")) { section = noAccent(first).replace(/^#\s*/, "").toUpperCase(); hdr = null; continue; }
    if (!hdr) { hdr = r.map((h) => noAccent(h).trim().toLowerCase()); continue; }

    if (section.startsWith("PERSONNE")) {
      const id = col(r, "id") || uid();
      const nom = col(r, "nom") || col(r, "libelle");
      st.personnes.push({ id, nom, role: col(r, "role") || "enfant", naissance: col(r, "naissance") });
      persByName[nom.toLowerCase()] = id;
    } else if (section.startsWith("ACTIF")) {
      const id = col(r, "id") || uid();
      const lib = col(r, "libelle");
      const an = col(r, "annee_demembrement");
      const a = { id, libelle: lib, categorie: col(r, "categorie") || "autre", valeur: num(col(r, "valeur")), dutreil: yes(col(r, "dutreil")) };
      if (an) a.demembrementAnnee = num(an);
      st.actifs.push(a);
      actByName[lib.toLowerCase()] = id;
    } else if (section.startsWith("DETENTION")) {
      const prop = col(r, "detenteur_id") || resolve(col(r, "detenteur"), persByName) || resolve(col(r, "detenteur"), actByName) || col(r, "detenteur");
      const act = col(r, "actif_id") || resolve(col(r, "actif"), actByName) || col(r, "actif");
      st.detentions.push({ proprietaire: prop, actifRef: act, part: num(col(r, "part_pct")), droit: (col(r, "droit") || "PP").toUpperCase() });
    } else if (section.startsWith("DETTE")) {
      const cible = col(r, "adosse_a_id") || resolve(col(r, "adosse_a"), actByName) || resolve(col(r, "adosse_a"), persByName) || col(r, "adosse_a");
      st.dettes.push({ id: col(r, "id") || uid(), libelle: col(r, "libelle"), montant: num(col(r, "montant")), cible });
    } else if (section.startsWith("DONATION")) {
      const don = col(r, "donateur_id") || resolve(col(r, "donateur"), persByName) || col(r, "donateur");
      const ben = col(r, "beneficiaire_id") || resolve(col(r, "beneficiaire"), persByName) || col(r, "beneficiaire");
      st.donations.push({ id: uid(), donateurId: don, beneficiaireId: ben, date: col(r, "date"), montant: num(col(r, "montant")), nature: "pleine", lien: "enfant", note: col(r, "note") });
    } else if (section.startsWith("ASSURANCE") || section.startsWith("AV") || section.startsWith("PER")) {
      const sous = col(r, "souscripteur_id") || resolve(col(r, "souscripteur"), persByName) || col(r, "souscripteur");
      const reg = col(r, "regime");
      const bens = col(r, "beneficiaires").split(/[;|]/).map((s) => s.trim()).filter(Boolean).map((x) => resolve(x, persByName) || x);
      st.av.push({ id: col(r, "id") || uid(), libelle: col(r, "libelle"), etablissement: col(r, "etablissement"), souscripteurId: sous, montant: num(col(r, "capital") || col(r, "valeur")), avant70: /avant/i.test(reg) || yes(reg), per: yes(col(r, "per")), clauseType: col(r, "clause") || "designe", beneficiaires: bens });
    } else if (section.startsWith("REGIME") || section.startsWith("PARAM")) {
      st.regime = col(r, "regime") || String(r[0] ?? "").trim();
    }
  }
  if (!st.personnes.length) throw new Error("Aucune personne trouvée dans le CSV.");
  return st;
}

// Ancien format plat (colonne `type`) — conservé pour rétrocompatibilité
function csvToStateFlat(rows) {
  const header = rows[0].map((h) => h.trim().replace(/^#\s*/, "").toLowerCase());
  const idx = {};
  COLUMNS.forEach((c) => (idx[c] = header.indexOf(c)));
  const get = (r, c) => (idx[c] >= 0 ? (r[idx[c]] ?? "").trim() : "");
  const st = { personnes: [], actifs: [], detentions: [], dettes: [], donations: [], av: [] };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = get(r, "type").toLowerCase();
    if (!type || type.startsWith("#")) continue;
    switch (type) {
      case "personne":
        st.personnes.push({ id: get(r, "id") || uid(), nom: get(r, "libelle"), role: get(r, "role") || "enfant", naissance: get(r, "naissance") });
        break;
      case "actif":
        st.actifs.push({ id: get(r, "id") || uid(), libelle: get(r, "libelle"), categorie: get(r, "categorie") || "autre", valeur: num(get(r, "valeur")), dutreil: yes(get(r, "dutreil")) });
        break;
      case "detention":
        st.detentions.push({ proprietaire: get(r, "proprietaire"), actifRef: get(r, "actif_ref"), part: num(get(r, "part_pct")), droit: (get(r, "droit") || "PP").toUpperCase(), note: get(r, "note") });
        break;
      case "dette":
        st.dettes.push({ id: get(r, "id") || uid(), libelle: get(r, "libelle"), montant: num(get(r, "valeur")), cible: get(r, "actif_ref") || get(r, "proprietaire"), note: get(r, "note") });
        break;
      case "donation":
        st.donations.push({ id: uid(), donateurId: get(r, "proprietaire"), beneficiaireId: get(r, "beneficiaire"), date: get(r, "date"), montant: num(get(r, "montant")), nature: "pleine", lien: "enfant", note: get(r, "note") });
        break;
      case "av":
        st.av.push({ id: get(r, "id") || uid(), libelle: get(r, "libelle"), etablissement: get(r, "categorie"), souscripteurId: get(r, "proprietaire"), montant: num(get(r, "valeur")), beneficiaires: get(r, "beneficiaire").split(/[;|]/).map((s) => s.trim()).filter(Boolean), avant70: /oui|1|true|avant/i.test(get(r, "avant_70")), note: get(r, "note") });
        break;
      default:
        break;
    }
  }
  if (!st.personnes.length) throw new Error("Aucune personne trouvée dans le CSV.");
  return st;
}
