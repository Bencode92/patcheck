import {
  ABATTEMENTS, DON_FAMILIAL_SOMME, DELAI_RAPPEL_ANS,
  BAREMES_PAR_LIEN, LIBELLE_LIEN, calculDroits, tauxUsufruit,
  BAREME_LIGNE_DIRECTE, BAREME_USUFRUIT, AV_AVANT_70, AV_APRES_70,
} from "./data.js";
import { templateCSV, stateToCSV, csvToState } from "./csv.js";
import { buildMermaid, debrief } from "./graph.js";

// ---------- Utilitaires ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const eur = (n) =>
  (n ?? 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(0) + " %";
const parseNum = (v) => Number(String(v).replace(/[^\d.-]/g, "")) || 0;

function ageAu(naissance, dateRef = new Date()) {
  if (!naissance) return null;
  const n = new Date(naissance);
  let age = dateRef.getFullYear() - n.getFullYear();
  const m = dateRef.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && dateRef.getDate() < n.getDate())) age--;
  return age;
}
function anneesEcoulees(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return (now - d) / (365.25 * 24 * 3600 * 1000);
}

// ---------- État ----------
const KEY = "patrimoine_famille_v1";
const defaultState = () => ({
  personnes: [
    { id: uid(), nom: "Parent 1", role: "parent", naissance: "" },
    { id: uid(), nom: "Parent 2", role: "parent", naissance: "" },
    { id: uid(), nom: "Enfant 1", role: "enfant", naissance: "" },
    { id: uid(), nom: "Enfant 2", role: "enfant", naissance: "" },
    { id: uid(), nom: "Enfant 3", role: "enfant", naissance: "" },
  ],
  actifs: [],
  detentions: [],
  donations: [],
  av: [],
});
let state = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : defaultState();
    // rétro-compat : garantit les nouveaux tableaux
    s.actifs ||= [];
    s.detentions ||= [];
    s.donations ||= [];
    s.av ||= [];
    return s;
  } catch {
    return defaultState();
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}
const personne = (id) => state.personnes.find((p) => p.id === id);
const parents = () => state.personnes.filter((p) => p.role === "parent");
const enfants = () => state.personnes.filter((p) => p.role === "enfant");

// =============================================================
//  Calculs métier
// =============================================================

// Donations d'un donateur vers un bénéficiaire encore dans le
// délai de rappel fiscal (15 ans). Renvoie total consommé + détail.
function abattementConsomme(donateurId, beneficiaireId) {
  const actives = state.donations.filter(
    (d) =>
      d.donateurId === donateurId &&
      d.beneficiaireId === beneficiaireId &&
      anneesEcoulees(d.date) < DELAI_RAPPEL_ANS
  );
  const total = actives.reduce((s, d) => s + parseNum(d.montant), 0);
  return { total, donations: actives };
}

function abattementPlafond(lien) {
  return ABATTEMENTS[lien] ?? ABATTEMENTS.defaut;
}

// Simulation d'une transmission (donation ou succession)
// options: { montantPP, lien, ageUsufruitier, mode, donateurId, beneficiaireId }
// mode : 'pleine' | 'nue_propriete' | 'usufruit'
function simulerTransmission(o) {
  const lien = o.lien || "enfant";
  let baseTaxable = parseNum(o.montantPP);
  let tauxUS = null;
  if (o.mode === "nue_propriete" || o.mode === "usufruit") {
    tauxUS = tauxUsufruit(o.ageUsufruitier ?? 60);
    baseTaxable =
      o.mode === "nue_propriete"
        ? baseTaxable * (1 - tauxUS) // on transmet la NP
        : baseTaxable * tauxUS; // on transmet l'US
  }

  const plafond = abattementPlafond(lien);
  let dejaConsomme = 0;
  if (o.donateurId && o.beneficiaireId) {
    dejaConsomme = abattementConsomme(o.donateurId, o.beneficiaireId).total;
  }
  const abattementRestant = Math.max(0, plafond - dejaConsomme);
  const apresAbattement = Math.max(0, baseTaxable - abattementRestant);
  const bareme = BAREMES_PAR_LIEN[lien] || BAREMES_PAR_LIEN.defaut;
  const droits = calculDroits(apresAbattement, bareme);

  return {
    valeurPP: parseNum(o.montantPP),
    tauxUS,
    baseTaxable: Math.round(baseTaxable),
    plafondAbattement: plafond,
    dejaConsomme,
    abattementRestant,
    apresAbattement: Math.round(apresAbattement),
    droits,
    net: Math.round(baseTaxable - droits),
    tauxEffectif: baseTaxable > 0 ? droits / baseTaxable : 0,
  };
}

// Assurance-vie : primes avant 70 ans (990 I)
function simulerAvAvant70(montant) {
  const apres = Math.max(0, montant - AV_AVANT_70.abattement);
  const t1 = Math.min(apres, AV_AVANT_70.seuilTranche1);
  const t2 = Math.max(0, apres - AV_AVANT_70.seuilTranche1);
  const droits = Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2);
  return { abattement: AV_AVANT_70.abattement, apres, droits, net: montant - droits };
}

// =============================================================
//  Rendu — navigation par onglets
// =============================================================
const TABS = [
  { id: "donnees", label: "📥 Données (CSV)" },
  { id: "organigramme", label: "🗺️ Organigramme & Débrief" },
  { id: "famille", label: "👪 Famille" },
  { id: "donations", label: "🎁 Donations réalisées" },
  { id: "abattements", label: "📊 Abattements dispo." },
  { id: "simulateur", label: "🧮 Simulateur" },
  { id: "assurancevie", label: "🛡️ Assurance-vie" },
  { id: "baremes", label: "📚 Barèmes" },
];
let currentTab = "donnees";

function render() {
  const app = $("#app");
  app.innerHTML = `
    <nav class="tabs">
      ${TABS.map(
        (t) =>
          `<button class="tab ${t.id === currentTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`
      ).join("")}
    </nav>
    <main id="tab-content"></main>`;
  $$(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      currentTab = b.dataset.tab;
      render();
    })
  );
  ({
    donnees: renderDonnees,
    organigramme: renderOrganigramme,
    famille: renderFamille,
    donations: renderDonations,
    abattements: renderAbattements,
    simulateur: renderSimulateur,
    assurancevie: renderAv,
    baremes: renderBaremes,
  })[currentTab]();
}

function download(name, content, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// ---------- Onglet Données (CSV) ----------
function renderDonnees() {
  const c = $("#tab-content");
  const n = (arr) => (arr || []).length;
  c.innerHTML = `
    <div class="card">
      <h2>Import / export CSV</h2>
      <p class="muted">Remplis un tableur avec tes vraies données, exporte en CSV, puis importe-le ici. L'organigramme et le débrief se génèrent automatiquement.</p>
      <div class="form-row" style="align-items:center">
        <button id="dl_template" class="btn primary">⬇ Télécharger le modèle CSV</button>
        <button id="dl_export" class="btn">⬇ Exporter mes données (CSV)</button>
        <label class="btn ghost">⬆ Importer un CSV<input id="csv_in" type="file" accept=".csv,text/csv" hidden></label>
      </div>
      <div id="csv_msg"></div>
    </div>

    <div class="card">
      <h3>Contenu actuel</h3>
      <div class="chips">
        <span class="chip">👤 ${n(state.personnes)} personnes</span>
        <span class="chip">🏦 ${n(state.actifs)} actifs</span>
        <span class="chip">🔗 ${n(state.detentions)} détentions</span>
        <span class="chip">🎁 ${n(state.donations)} donations</span>
        <span class="chip">🛡️ ${n(state.av)} contrats AV</span>
      </div>
    </div>

    <div class="card">
      <h3>Comment remplir le modèle</h3>
      <table class="grid"><thead><tr><th>type</th><th>À quoi ça sert</th><th>Colonnes utiles</th></tr></thead><tbody>
        <tr><td><b>personne</b></td><td>Chaque membre du foyer</td><td>id, libelle, role (parent/enfant), naissance</td></tr>
        <tr><td><b>actif</b></td><td>Un bien / SCI / entreprise / compte</td><td>id, libelle, categorie (sci/immobilier/entreprise/liquidites/titres), valeur</td></tr>
        <tr><td><b>detention</b></td><td>Qui détient quoi</td><td>proprietaire (id perso ou SCI), actif_ref, part_pct, droit (PP/US/NP)</td></tr>
        <tr><td><b>donation</b></td><td>Donation déjà faite</td><td>proprietaire (donateur), beneficiaire, date, montant</td></tr>
        <tr><td><b>av</b></td><td>Contrat d'assurance-vie</td><td>id, libelle, proprietaire (souscripteur), valeur, beneficiaire (séparés par ;), avant_70 (oui/non)</td></tr>
      </tbody></table>
      <p class="muted small">💡 <b>id</b> = un code court que tu choisis (P1, E1, SCI1…) et que tu réutilises dans les colonnes <b>proprietaire</b>, <b>actif_ref</b>, <b>beneficiaire</b> pour relier les lignes entre elles.</p>
    </div>`;

  $("#dl_template").addEventListener("click", () => download("modele-patrimoine.csv", templateCSV()));
  $("#dl_export").addEventListener("click", () => download("mes-donnees-patrimoine.csv", stateToCSV(state)));
  $("#csv_in").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = csvToState(reader.result);
        state = imported;
        save();
        $("#csv_msg").innerHTML = `<div class="result"><b style="color:var(--accent-2)">✅ Import réussi</b> — ${state.personnes.length} personnes, ${state.actifs.length} actifs, ${state.detentions.length} détentions, ${state.donations.length} donations, ${state.av.length} contrats AV. Va dans l'onglet <b>Organigramme & Débrief</b>.</div>`;
        renderDonnees();
      } catch (err) {
        $("#csv_msg").innerHTML = `<div class="result"><b style="color:var(--danger)">❌ Erreur : ${err.message}</b><br><span class="muted small">Vérifie l'entête et le séparateur (virgule).</span></div>`;
      }
    };
    reader.readAsText(file);
  });
}

// ---------- Onglet Organigramme & Débrief ----------
async function renderOrganigramme() {
  const c = $("#tab-content");
  const hasData = (state.actifs || []).length || (state.detentions || []).length || state.donations.length;
  const d = debrief(state);
  const eur = (n) => Math.round(n || 0).toLocaleString("fr-FR") + " €";

  const persoRows = state.personnes
    .map((p) => `<div class="line"><span>${p.nom} <small class="muted">(${p.role})</small></span><b>${eur(d.parPersonne[p.id] || 0)}</b></div>`)
    .join("");
  const catRows = Object.entries(d.parCategorie)
    .map(([k, v]) => `<div class="line"><span>${k}</span><b>${eur(v)}</b></div>`)
    .join("") || `<div class="muted small">Aucun actif saisi.</div>`;

  c.innerHTML = `
    ${
      hasData
        ? ""
        : `<div class="card"><b>Aucune donnée patrimoniale.</b> Va dans <b>📥 Données (CSV)</b>, télécharge le modèle, remplis-le et importe-le.</div>`
    }
    <div class="grid-2">
      <div class="card">
        <h3>💰 Patrimoine par personne</h3>
        <div class="result">${persoRows}
          <div class="line total"><span>Total foyer</span><b>${eur(d.patrimoineFoyer)}</b></div>
        </div>
        <p class="muted small">Les biens logés dans une SCI ne sont pas recomptés : chacun détient des <i>parts</i> de SCI.</p>
      </div>
      <div class="card">
        <h3>🏦 Répartition par catégorie</h3>
        <div class="result">${catRows}</div>
      </div>
      <div class="card">
        <h3>🎁 Donations</h3>
        <div class="result">
          <div class="line"><span>Total déjà donné</span><b>${eur(d.dejaDonneTotal)}</b></div>
          <div class="line"><span>Encore rapportable (&lt;15 ans)</span><b>${eur(d.rapportable)}</b></div>
          <div class="line"><span>Purgé (&gt;15 ans)</span><b>${eur(d.purge)}</b></div>
          <div class="line total"><span>Capacité de don exonérée restante</span><b>${eur(d.capaciteExoneree)}</b></div>
        </div>
      </div>
      <div class="card">
        <h3>🛡️ Assurance-vie & succession</h3>
        <div class="result">
          <div class="line"><span>Capital AV avant 70 ans</span><b>${eur(d.avAvant70)}</b></div>
          <div class="line"><span>Capital AV après 70 ans</span><b>${eur(d.avApres70)}</b></div>
          <div class="line total"><span>Droits succession estimés*</span><b>${eur(d.droitsSuccessionEstimes)}</b></div>
        </div>
        <p class="muted small">*Estimation simplifiée : décès des 2 parents, patrimoine réparti également entre ${d.nbEnfants} enfant(s), 2 abattements de 100 000 € par enfant. Hors AV. Voir l'onglet Simulateur pour le détail.</p>
      </div>
    </div>

    <div class="card">
      <h2>⚰️ Si décès aujourd'hui — droits par enfant</h2>
      <p class="muted small">Hypothèse : décès des ${d.nbParents} parent(s), patrimoine du foyer (${eur(d.patrimoineFoyer)}) réparti également entre ${d.nbEnfants} enfant(s). Abattement de 100 000 € par parent et par enfant, minoré des donations des 15 dernières années. Hors assurance-vie (fiscalité propre).</p>
      <table class="grid"><thead><tr>
        <th>Enfant</th><th>Part reçue</th><th>Abattement dispo.</th><th>Base taxable</th><th>Droits à payer</th><th>Net perçu</th><th>Taux</th>
      </tr></thead><tbody>
      ${
        (d.successionParEnfant || [])
          .map(
            (e) => `<tr>
          <td><b>${e.nom}</b></td>
          <td>${eur(e.recu)}</td>
          <td>${eur(e.abattement)}</td>
          <td>${eur(e.base)}</td>
          <td style="color:var(--warn)"><b>${eur(e.droits)}</b></td>
          <td>${eur(e.net)}</td>
          <td>${(e.tauxEffectif * 100).toFixed(1)} %</td>
        </tr>`
          )
          .join("") || `<tr><td colspan="7" class="muted center">Ajoute des enfants et des actifs.</td></tr>`
      }
      </tbody>
      <tfoot><tr>
        <th>Total foyer</th><td>${eur(d.patrimoineFoyer)}</td><td></td><td></td>
        <td style="color:var(--warn)"><b>${eur(d.droitsSuccessionEstimes)}</b></td><td></td><td></td>
      </tr></tfoot>
      </table>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">🗺️ Organigramme patrimonial</h2>
        <button id="dl_svg" class="btn ghost">⬇ Exporter l'image (SVG)</button>
      </div>
      <div id="mermaid-box" class="mermaid-box"><div class="muted">Génération du schéma…</div></div>
      <p class="muted small">Traits pleins = pleine propriété · pointillés = démembrement (US/NP) · flèches épaisses = donations réalisées.</p>
    </div>`;

  // Rendu Mermaid (import dynamique depuis CDN)
  const box = $("#mermaid-box");
  const def = buildMermaid(state);
  try {
    const mermaid = (await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose", flowchart: { curve: "basis" } });
    const { svg } = await mermaid.render("orgchart", def);
    box.innerHTML = svg;
    $("#dl_svg").addEventListener("click", () => download("organigramme-patrimoine.svg", box.innerHTML, "image/svg+xml"));
  } catch (err) {
    box.innerHTML = `<div class="muted">⚠️ Impossible de charger le moteur graphique (connexion Internet requise pour la 1re fois).<br>Définition du schéma :</div><pre class="code">${def.replace(/</g, "&lt;")}</pre>`;
  }
}

// ---------- Onglet Famille ----------
function renderFamille() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Composition du foyer</h2>
      <p class="muted">Renseigne les personnes. La date de naissance sert au barème de démembrement (art. 669 CGI).</p>
      <table class="grid">
        <thead><tr><th>Nom</th><th>Rôle</th><th>Naissance</th><th>Âge</th><th></th></tr></thead>
        <tbody>
        ${state.personnes
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td><input class="nom" value="${p.nom}"></td>
            <td>
              <select class="role">
                <option value="parent" ${p.role === "parent" ? "selected" : ""}>Parent</option>
                <option value="enfant" ${p.role === "enfant" ? "selected" : ""}>Enfant</option>
                <option value="petit_enfant" ${p.role === "petit_enfant" ? "selected" : ""}>Petit-enfant</option>
              </select>
            </td>
            <td><input type="date" class="naissance" value="${p.naissance}"></td>
            <td class="age">${p.naissance ? ageAu(p.naissance) + " ans" : "—"}</td>
            <td><button class="del danger-link">✕</button></td>
          </tr>`
          )
          .join("")}
        </tbody>
      </table>
      <button id="addP" class="btn">+ Ajouter une personne</button>
    </div>`;

  $$("#tab-content tr[data-id]").forEach((tr) => {
    const id = tr.dataset.id;
    $(".nom", tr).addEventListener("input", (e) => {
      personne(id).nom = e.target.value;
      save();
    });
    $(".role", tr).addEventListener("change", (e) => {
      personne(id).role = e.target.value;
      save();
    });
    $(".naissance", tr).addEventListener("change", (e) => {
      personne(id).naissance = e.target.value;
      save();
      renderFamille();
    });
    $(".del", tr).addEventListener("click", () => {
      state.personnes = state.personnes.filter((p) => p.id !== id);
      save();
      renderFamille();
    });
  });
  $("#addP").addEventListener("click", () => {
    state.personnes.push({ id: uid(), nom: "Nouvelle personne", role: "enfant", naissance: "" });
    save();
    renderFamille();
  });
}

// ---------- Onglet Donations réalisées ----------
function renderDonations() {
  const c = $("#tab-content");
  const rows = [...state.donations].sort((a, b) => (a.date < b.date ? 1 : -1));
  c.innerHTML = `
    <div class="card">
      <h2>Historique des donations</h2>
      <p class="muted">Chaque donation consomme l'abattement du couple donateur → bénéficiaire pendant ${DELAI_RAPPEL_ANS} ans (rappel fiscal). Au-delà, l'abattement se recharge.</p>
      <table class="grid">
        <thead><tr>
          <th>Date</th><th>Donateur</th><th>Bénéficiaire</th><th>Nature</th>
          <th>Valeur taxable</th><th>Statut rappel</th><th></th>
        </tr></thead>
        <tbody>
        ${
          rows.length === 0
            ? `<tr><td colspan="7" class="muted center">Aucune donation enregistrée.</td></tr>`
            : rows
                .map((d) => {
                  const ecoul = anneesEcoulees(d.date);
                  const actif = ecoul < DELAI_RAPPEL_ANS;
                  const restant = Math.max(0, DELAI_RAPPEL_ANS - ecoul);
                  return `<tr data-id="${d.id}" class="${actif ? "" : "purged"}">
                    <td>${d.date || "—"}</td>
                    <td>${personne(d.donateurId)?.nom ?? "?"}</td>
                    <td>${personne(d.beneficiaireId)?.nom ?? "?"}</td>
                    <td>${natureLabel(d.nature)}</td>
                    <td>${eur(parseNum(d.montant))}</td>
                    <td>${
                      actif
                        ? `<span class="badge warn">rapportable — ${restant.toFixed(1)} an(s) restants</span>`
                        : `<span class="badge ok">purgée (&gt;${DELAI_RAPPEL_ANS} ans)</span>`
                    }</td>
                    <td><button class="del danger-link">✕</button></td>
                  </tr>`;
                })
                .join("")
        }
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Ajouter une donation</h3>
      <div class="form-row">
        <label>Date<input type="date" id="d_date"></label>
        <label>Donateur${selectPersonnes("d_don", parents())}</label>
        <label>Bénéficiaire${selectPersonnes("d_ben", enfants())}</label>
      </div>
      <div class="form-row">
        <label>Nature
          <select id="d_nature">
            <option value="pleine">Pleine propriété</option>
            <option value="nue_propriete">Nue-propriété (démembrement)</option>
            <option value="somme_argent">Don de somme d'argent (790 G)</option>
          </select>
        </label>
        <label>Valeur taxable transmise (€)<input type="text" id="d_montant" placeholder="ex : 50000"></label>
        <label>Note<input type="text" id="d_note" placeholder="bien, réf. acte…"></label>
      </div>
      <button id="addDon" class="btn primary">Enregistrer la donation</button>
    </div>`;

  $$("#tab-content tr[data-id]").forEach((tr) =>
    $(".del", tr)?.addEventListener("click", () => {
      state.donations = state.donations.filter((d) => d.id !== tr.dataset.id);
      save();
      renderDonations();
    })
  );
  $("#addDon").addEventListener("click", () => {
    const don = {
      id: uid(),
      date: $("#d_date").value,
      donateurId: $("#d_don").value,
      beneficiaireId: $("#d_ben").value,
      nature: $("#d_nature").value,
      montant: parseNum($("#d_montant").value),
      note: $("#d_note").value,
      lien: "enfant",
    };
    if (!don.date || !don.montant) {
      alert("Renseigne au moins une date et un montant.");
      return;
    }
    state.donations.push(don);
    save();
    renderDonations();
  });
}
function natureLabel(n) {
  return { pleine: "Pleine propriété", nue_propriete: "Nue-propriété", somme_argent: "Somme d'argent (790 G)", usufruit: "Usufruit" }[n] || n;
}
function selectPersonnes(id, list, selected) {
  return `<select id="${id}">${list
    .map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${p.nom}</option>`)
    .join("")}</select>`;
}

// ---------- Onglet Abattements disponibles ----------
function renderAbattements() {
  const c = $("#tab-content");
  const cells = enfants()
    .map((enf) => {
      const parCol = parents()
        .map((par) => {
          const { total } = abattementConsomme(par.id, enf.id);
          const plafond = ABATTEMENTS.enfant;
          const restant = Math.max(0, plafond - total);
          const ratio = Math.min(1, total / plafond);
          return `<td>
            <div class="gauge"><div class="gauge-fill" style="width:${ratio * 100}%"></div></div>
            <div class="gauge-lbl"><b>${eur(restant)}</b> dispo.<br><span class="muted">${eur(total)} / ${eur(plafond)} consommé</span></div>
          </td>`;
        })
        .join("");
      return `<tr><th>${enf.nom}</th>${parCol}</tr>`;
    })
    .join("");

  const totalDispo = enfants().reduce((s, enf) => {
    return (
      s +
      parents().reduce((ss, par) => ss + Math.max(0, ABATTEMENTS.enfant - abattementConsomme(par.id, enf.id).total), 0)
    );
  }, 0);

  c.innerHTML = `
    <div class="card">
      <h2>Abattements encore disponibles</h2>
      <p class="muted">Abattement de ${eur(ABATTEMENTS.enfant)} par parent et par enfant, rechargé tous les ${DELAI_RAPPEL_ANS} ans. Ci-dessous ce qu'il reste à transmettre <b>en franchise de droits</b>.</p>
      <div class="kpi"><span>Capacité totale de donation exonérée immédiate</span><b>${eur(totalDispo)}</b></div>
      <table class="grid matrix">
        <thead><tr><th></th>${parents().map((p) => `<th>${p.nom}</th>`).join("")}</tr></thead>
        <tbody>${cells}</tbody>
      </table>
      <p class="muted small">💡 En plus, le <b>don familial de somme d'argent</b> (art. 790 G) ajoute ${eur(DON_FAMILIAL_SOMME)} par parent &lt; 80 ans vers chaque enfant majeur, également tous les ${DELAI_RAPPEL_ANS} ans.</p>
    </div>`;
}

// ---------- Onglet Simulateur ----------
function renderSimulateur() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Simulateur de transmission</h2>
      <div class="form-row">
        <label>Donateur${selectPersonnes("s_don", parents())}</label>
        <label>Bénéficiaire${selectPersonnes("s_ben", enfants())}</label>
        <label>Lien fiscal
          <select id="s_lien">
            ${Object.entries(LIBELLE_LIEN)
              .filter(([k]) => BAREMES_PAR_LIEN[k])
              .map(([k, v]) => `<option value="${k}" ${k === "enfant" ? "selected" : ""}>${v}</option>`)
              .join("")}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>Valeur en pleine propriété (€)<input type="text" id="s_montant" value="300000"></label>
        <label>Mode de transmission
          <select id="s_mode">
            <option value="pleine">Pleine propriété</option>
            <option value="nue_propriete">Nue-propriété (garder l'usufruit)</option>
            <option value="usufruit">Usufruit seul</option>
          </select>
        </label>
        <label>Âge de l'usufruitier<input type="number" id="s_age" value="65" min="0" max="110"></label>
      </div>
      <button id="s_go" class="btn primary">Calculer</button>
      <div id="s_result"></div>
    </div>`;

  // pré-remplir âge avec celui du donateur
  const syncAge = () => {
    const p = personne($("#s_don").value);
    if (p?.naissance) $("#s_age").value = ageAu(p.naissance);
  };
  $("#s_don").addEventListener("change", syncAge);
  syncAge();

  $("#s_go").addEventListener("click", () => {
    const r = simulerTransmission({
      montantPP: $("#s_montant").value,
      lien: $("#s_lien").value,
      mode: $("#s_mode").value,
      ageUsufruitier: Number($("#s_age").value),
      donateurId: $("#s_don").value,
      beneficiaireId: $("#s_ben").value,
    });
    $("#s_result").innerHTML = `
      <div class="result">
        <div class="line"><span>Valeur en pleine propriété</span><b>${eur(r.valeurPP)}</b></div>
        ${
          r.tauxUS !== null
            ? `<div class="line"><span>Barème 669 CGI (usufruit ${pct(r.tauxUS)} / NP ${pct(1 - r.tauxUS)})</span><b>base transmise ${eur(r.baseTaxable)}</b></div>`
            : ""
        }
        <div class="line"><span>Abattement du lien</span><b>${eur(r.plafondAbattement)}</b></div>
        <div class="line"><span>Déjà consommé (&lt;15 ans)</span><b>− ${eur(r.dejaConsomme)}</b></div>
        <div class="line"><span>Abattement restant applicable</span><b>${eur(r.abattementRestant)}</b></div>
        <div class="line"><span>Base taxable après abattement</span><b>${eur(r.apresAbattement)}</b></div>
        <div class="line total"><span>Droits de donation à payer</span><b>${eur(r.droits)}</b></div>
        <div class="line"><span>Taux effectif sur la part transmise</span><b>${pct(r.tauxEffectif)}</b></div>
      </div>
      <p class="muted small">Comparaison : en pleine propriété directe, transmettre ${eur(r.valeurPP)} coûterait ${eur(
        simulerTransmission({ montantPP: r.valeurPP, lien: $("#s_lien").value, mode: "pleine", donateurId: $("#s_don").value, beneficiaireId: $("#s_ben").value }).droits
      )} de droits. Le démembrement réduit l'assiette taxable à la seule nue-propriété.</p>`;
  });
}

// ---------- Onglet Assurance-vie ----------
function renderAv() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Assurance-vie — fiscalité au décès</h2>
      <div class="form-row">
        <label>Régime des primes
          <select id="av_regime">
            <option value="avant">Versées AVANT 70 ans (art. 990 I)</option>
            <option value="apres">Versées APRÈS 70 ans (art. 757 B)</option>
          </select>
        </label>
        <label>Capital / prime par bénéficiaire (€)<input type="text" id="av_montant" value="200000"></label>
      </div>
      <button id="av_go" class="btn primary">Calculer</button>
      <div id="av_result"></div>
      <p class="muted small">Avant 70 ans : abattement de ${eur(AV_AVANT_70.abattement)} <b>par bénéficiaire</b>, puis 20 % jusqu'à ${eur(
        AV_AVANT_70.seuilTranche1
      )} et 31,25 % au-delà. Après 70 ans : abattement global de ${eur(
        AV_APRES_70.abattementGlobal
      )} (tous bénéficiaires), les primes excédentaires réintègrent la succession — mais les gains restent exonérés.</p>
    </div>`;
  $("#av_go").addEventListener("click", () => {
    const m = parseNum($("#av_montant").value);
    const regime = $("#av_regime").value;
    let html;
    if (regime === "avant") {
      const r = simulerAvAvant70(m);
      html = `<div class="result">
        <div class="line"><span>Capital transmis</span><b>${eur(m)}</b></div>
        <div class="line"><span>Abattement (990 I)</span><b>− ${eur(r.abattement)}</b></div>
        <div class="line"><span>Base taxable</span><b>${eur(r.apres)}</b></div>
        <div class="line total"><span>Prélèvement</span><b>${eur(r.droits)}</b></div>
        <div class="line"><span>Net perçu</span><b>${eur(r.net)}</b></div>
      </div>`;
    } else {
      const apres = Math.max(0, m - AV_APRES_70.abattementGlobal);
      html = `<div class="result">
        <div class="line"><span>Primes versées après 70 ans</span><b>${eur(m)}</b></div>
        <div class="line"><span>Abattement global (757 B)</span><b>− ${eur(AV_APRES_70.abattementGlobal)}</b></div>
        <div class="line total"><span>Primes réintégrées à l'actif successoral</span><b>${eur(apres)}</b></div>
        <div class="line"><span class="muted">Ces primes seront taxées au barème de succession selon le lien (voir onglet Barèmes). Les intérêts/gains restent exonérés.</span></div>
      </div>`;
    }
    $("#av_result").innerHTML = html;
  });
}

// ---------- Onglet Barèmes ----------
function renderBaremes() {
  const c = $("#tab-content");
  const tranches = (b) =>
    b
      .map((t, i) => {
        const bas = i === 0 ? 0 : b[i - 1].plafond;
        return `<tr><td>${eur(bas)} – ${t.plafond === Infinity ? "∞" : eur(t.plafond)}</td><td>${pct(t.taux)}</td></tr>`;
      })
      .join("");
  c.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Droits en ligne directe (parent → enfant)</h3>
        <table class="grid"><thead><tr><th>Part nette taxable</th><th>Taux</th></tr></thead><tbody>${tranches(
          BAREME_LIGNE_DIRECTE
        )}</tbody></table>
      </div>
      <div class="card">
        <h3>Abattements (renouvelables /15 ans)</h3>
        <table class="grid"><tbody>
          <tr><td>Enfant</td><td>${eur(ABATTEMENTS.enfant)}</td></tr>
          <tr><td>Petit-enfant</td><td>${eur(ABATTEMENTS.petit_enfant)}</td></tr>
          <tr><td>Époux / PACS (donation)</td><td>${eur(ABATTEMENTS.epoux_pacs)}</td></tr>
          <tr><td>Frère / sœur</td><td>${eur(ABATTEMENTS.frere_soeur)}</td></tr>
          <tr><td>Don familial somme (790 G)</td><td>${eur(DON_FAMILIAL_SOMME)}</td></tr>
          <tr><td>Personne handicapée (cumulable)</td><td>${eur(ABATTEMENTS.handicap)}</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <h3>Démembrement — art. 669 CGI</h3>
        <p class="muted small">Selon l'âge de l'usufruitier au jour de l'acte.</p>
        <table class="grid"><thead><tr><th>Âge usufruitier</th><th>Usufruit</th><th>Nue-propriété</th></tr></thead><tbody>
        ${BAREME_USUFRUIT.map((b, i) => {
          const bornBas = i === 0 ? 0 : BAREME_USUFRUIT[i - 1].ageMax + 1;
          const lbl = b.ageMax === 999 ? "91 ans et +" : `${bornBas} – ${b.ageMax} ans`;
          return `<tr><td>${lbl}</td><td>${pct(b.usufruit)}</td><td>${pct(1 - b.usufruit)}</td></tr>`;
        }).join("")}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Assurance-vie</h3>
        <table class="grid"><tbody>
          <tr><td>Abattement / bénéf. (avant 70 ans, 990 I)</td><td>${eur(AV_AVANT_70.abattement)}</td></tr>
          <tr><td>Taux jusqu'à ${eur(AV_AVANT_70.seuilTranche1)}</td><td>${pct(AV_AVANT_70.tauxTranche1)}</td></tr>
          <tr><td>Taux au-delà</td><td>${pct(AV_AVANT_70.tauxTranche2)}</td></tr>
          <tr><td>Abattement global (après 70 ans, 757 B)</td><td>${eur(AV_APRES_70.abattementGlobal)}</td></tr>
        </tbody></table>
      </div>
    </div>
    <p class="muted small center">⚠️ Barèmes indicatifs 2026 — à vérifier avec ton notaire / la loi de finances en vigueur.</p>`;
}

// ---------- Boot + gestion données ----------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "patrimoine-famille.json";
  a.click();
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = JSON.parse(reader.result);
      save();
      render();
    } catch {
      alert("Fichier invalide.");
    }
  };
  reader.readAsText(file);
}

document.addEventListener("DOMContentLoaded", () => {
  render();
  $("#export")?.addEventListener("click", exportData);
  $("#import")?.addEventListener("change", (e) => e.target.files[0] && importData(e.target.files[0]));
  $("#reset")?.addEventListener("click", () => {
    if (confirm("Réinitialiser toutes les données ?")) {
      state = defaultState();
      save();
      render();
    }
  });
});
