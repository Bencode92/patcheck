import {
  ABATTEMENTS, DON_FAMILIAL_SOMME, DELAI_RAPPEL_ANS,
  BAREMES_PAR_LIEN, LIBELLE_LIEN, calculDroits, tauxUsufruit,
  BAREME_LIGNE_DIRECTE, BAREME_USUFRUIT, AV_AVANT_70, AV_APRES_70,
} from "./data.js?v=11";
import { templateCSV, stateToCSV, csvToState } from "./csv.js?v=11";
import { buildMermaid, debrief } from "./graph.js?v=11";
import * as sync from "./sync.js?v=11";

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
// Âge d'une personne : date complète d'abord (exact), sinon année seule, sinon âge saisi
function ageDe(p) {
  let a = null;
  if (p?.naissance) a = ageAu(p.naissance);
  else if (p?.annee) a = new Date().getFullYear() - Number(p.annee);
  else if (p?.age != null && p.age !== "") a = Number(p.age);
  return Number.isFinite(a) ? a : null; // évite d'afficher "NaN" sur une date incomplète
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
  dettes: [],
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
    s.dettes ||= [];
    s.donations ||= [];
    s.av ||= [];
    return s;
  } catch {
    return defaultState();
  }
}
let cloudStatusCb = null;
function save() {
  state._ts = Date.now(); // horodatage : sert à savoir quelle version est la plus récente
  localStorage.setItem(KEY, JSON.stringify(state));
  sync.scheduleAutoSave(() => state, (s, info) => cloudStatusCb?.(s, info));
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
  { id: "organigramme", label: "🏠 Résumé patrimonial" },
  { id: "famille", label: "👪 Famille" },
  { id: "patrimoine", label: "🏦 Patrimoine" },
  { id: "assurancevie", label: "🛡️ Assurance-vie" },
  { id: "donations", label: "🎁 Donations réalisées" },
  { id: "abattements", label: "📊 Abattements dispo." },
  { id: "simulateur", label: "🧮 Simulateur" },
  { id: "baremes", label: "📚 Barèmes" },
  { id: "donnees", label: "📥 Données & sauvegarde" },
];
let currentTab = "organigramme";

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
    patrimoine: renderPatrimoine,
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
    <div class="card" id="cloud-card">
      <h2>☁️ Sauvegarde en ligne</h2>
      <div id="cloud-body"><span class="muted">Détection du stockage cloud…</span></div>
    </div>

    <div class="card">
      <h2>Import / export CSV</h2>
      <p class="muted">Remplis un tableur avec tes vraies données, exporte en CSV, puis importe-le ici. L'organigramme et le débrief se génèrent automatiquement. Tu peux aussi ré-exporter à tout moment le CSV consolidé pour l'envoyer à un tiers.</p>
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
        <tr><td><b>dette</b></td><td>Un emprunt / passif</td><td>id, libelle, valeur (montant dû), actif_ref (SCI/bien grevé) ou proprietaire (dette perso)</td></tr>
      </tbody></table>
      <p class="muted small">💡 <b>id</b> = un code court que tu choisis (P1, E1, SCI1…) et que tu réutilises dans les colonnes <b>proprietaire</b>, <b>actif_ref</b>, <b>beneficiaire</b> pour relier les lignes entre elles.</p>
      <p class="muted small">🏭 <b>Pacte Dutreil</b> : sur une ligne <b>actif</b> de catégorie <code>entreprise</code>, mets <b>oui</b> dans la colonne <b>dutreil</b> pour appliquer l'exonération de 75 % (art. 787 B) sur l'assiette taxable.</p>
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

  renderCloudCard();
}

function renderCloudCard() {
  const body = $("#cloud-body");
  if (!body) return;
  const currentUrl = sync.getApiUrl();
  const isWorker = currentUrl.startsWith("http");
  body.innerHTML = `
    <p class="muted">Sauvegarde privée (protégée par mot de passe). Colle l'URL de ton <b>Worker Cloudflare</b> (finit par <code>.workers.dev</code>), ton mot de passe, puis teste la connexion.</p>
    <div class="form-row">
      <label>URL du Worker (Cloudflare)<input type="text" id="cl_url" value="${isWorker ? currentUrl : ""}" placeholder="https://patcheck.xxx.workers.dev"></label>
    </div>
    <div class="form-row">
      <label>Mot de passe<input type="password" id="cl_pwd" value="${sync.getPassword()}" placeholder="ton APP_PASSWORD Cloudflare"></label>
      <label style="flex-direction:row;align-items:center;gap:8px;min-width:200px">
        <input type="checkbox" id="cl_auto" ${sync.isAuto() ? "checked" : ""} style="width:auto"> Sauvegarde automatique
      </label>
    </div>
    <div class="form-row">
      <button id="cl_test" class="btn">🔌 Tester la connexion</button>
      <button id="cl_save" class="btn primary">☁️ Sauvegarder maintenant</button>
      <button id="cl_load" class="btn">⬇ Charger depuis le cloud</button>
    </div>
    <div id="cl_status" class="muted small"></div>`;

  const status = (msg, color = "var(--muted)") => ($("#cl_status").innerHTML = `<span style="color:${color}">${msg}</span>`);
  const syncFields = () => {
    const u = $("#cl_url").value.trim();
    sync.setApiUrl(u || "/api/data");
    sync.setPassword($("#cl_pwd").value);
  };
  cloudStatusCb = (s, info) => {
    if (s === "pending") status("💾 sauvegarde en cours…");
    else if (s === "saved") status("✅ sauvegardé " + (info ? "à " + new Date(info).toLocaleTimeString("fr-FR") : ""), "var(--accent-2)");
    else if (s === "error") status("⚠️ " + info, "var(--danger)");
  };
  $("#cl_url").addEventListener("input", syncFields);
  $("#cl_pwd").addEventListener("input", syncFields);
  $("#cl_auto").addEventListener("change", (e) => { sync.setAuto(e.target.checked); status(e.target.checked ? "auto-sauvegarde activée" : "auto-sauvegarde désactivée"); });
  $("#cl_test").addEventListener("click", async () => {
    syncFields();
    status("test en cours…");
    const ok = await sync.cloudAvailable();
    if (!ok) { status("❌ pas de réponse — vérifie l'URL du Worker (déployé ?)", "var(--danger)"); return; }
    try { await sync.cloudLoad(); status("✅ connexion OK, mot de passe accepté", "var(--accent-2)"); }
    catch (e) { status(e.message.includes("passe") ? "🔌 Worker joignable mais ❌ " + e.message : "⚠️ " + e.message, "var(--warn)"); }
  });
  $("#cl_save").addEventListener("click", async () => {
    syncFields();
    try { const r = await sync.cloudSave(state); status("✅ sauvegardé à " + new Date(r.savedAt).toLocaleTimeString("fr-FR"), "var(--accent-2)"); }
    catch (e) { status("❌ " + e.message, "var(--danger)"); }
  });
  $("#cl_load").addEventListener("click", async () => {
    syncFields();
    try {
      const data = await sync.cloudLoad();
      if (!data) { status("Aucune donnée en ligne pour l'instant.", "var(--warn)"); return; }
      state = data; save(); status("✅ données chargées depuis le cloud", "var(--accent-2)"); renderDonnees();
    } catch (e) { status("❌ " + e.message, "var(--danger)"); }
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
  const CAT_LBL = { immobilier: "🏠 Immobilier", sci: "🏢 SCI", entreprise: "🏭 Entreprise", liquidites: "💶 Liquidités", titres: "📈 Titres", autre: "Autre" };
  const totalCat = Object.values(d.parCategorie).reduce((s, v) => s + v, 0) || 1;
  const catRows = Object.entries(d.parCategorie)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const p = (v / totalCat) * 100;
      return `<div class="expo-row">
        <div class="expo-head"><span>${CAT_LBL[k] || k}</span><b>${eur(v)} <span class="muted">· ${p.toFixed(0)} %</span></b></div>
        <div class="gauge"><div class="gauge-fill" style="width:${p}%"></div></div>
      </div>`;
    })
    .join("") || `<div class="muted small">Aucun actif saisi — va dans l'onglet 🏦 Patrimoine.</div>`;

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
        <h3>📊 Exposition patrimoniale</h3>
        ${catRows}
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

    ${
      d.totalDettes > 0
        ? `<div class="card"><div class="result">
             <div class="line"><span>Valeur brute détenue par le foyer</span><b>${eur(d.patrimoineFoyer + d.totalDettes)}</b></div>
             <div class="line"><span>Dettes (SCI / pro / perso)</span><b style="color:var(--danger)">− ${eur(d.totalDettes)}</b></div>
             <div class="line total"><span>Patrimoine net du foyer</span><b>${eur(d.patrimoineFoyer)}</b></div>
           </div></div>`
        : ""
    }

    <div class="card">
      <h2>🎯 Clauses bénéficiaires (assurance-vie)</h2>
      ${
        (state.av || []).length
          ? `<table class="grid"><thead><tr><th>Contrat</th><th>Banque/Assureur</th><th>Souscripteur</th><th>Ouvert</th><th>Capital</th><th>Régime</th><th>Bénéficiaires</th></tr></thead><tbody>
            ${state.av
              .map((a) => {
                const bens = (a.beneficiaires || []).map((b) => {
                  const nom = personne(b)?.nom || b;
                  const p = a.repartition?.[b];
                  return p ? `${nom} (${p} %)` : nom;
                });
                const clause = a.clause ? `<div class="muted small" style="margin-top:4px">« ${a.clause} »</div>` : "";
                return `<tr>
                  <td><b>${a.libelle || a.id}</b></td>
                  <td>${a.etablissement || "—"}</td>
                  <td>${personne(a.souscripteurId)?.nom || a.souscripteurId || "?"}</td>
                  <td>${a.annee || "—"}</td>
                  <td>${eur(a.montant)}</td>
                  <td>${a.avant70 ? "avant 70 ans" : "après 70 ans"}</td>
                  <td>${bens.join(", ") || `<span class="badge warn">à définir</span>`}${clause}</td>
                </tr>`;
              })
              .join("")}
          </tbody></table>`
          : `<p class="muted">Aucun contrat d'assurance-vie saisi.</p>`
      }
    </div>

    ${
      (d.reco || []).length
        ? `<div class="card">
             <h2>✅ Reste à faire & optimisation</h2>
             <div class="reco-list">
               ${d.reco
                 .map((r) => `<div class="reco reco-${r.level}"><span class="reco-ico">${{ action: "➡️", info: "ℹ️", warn: "⚠️", ok: "✔️" }[r.level] || "•"}</span><span>${r.text}</span></div>`)
                 .join("")}
             </div>
           </div>`
        : ""
    }

    <div class="card">
      <h2>⚰️ Si décès aujourd'hui — droits par enfant</h2>
      <p class="muted small">Hypothèse : décès des ${d.nbParents} parent(s), patrimoine du foyer (${eur(d.patrimoineFoyer)}) réparti également entre ${d.nbEnfants} enfant(s). Abattement de 100 000 € par parent et par enfant, minoré des donations des 15 dernières années. Hors assurance-vie (fiscalité propre).</p>
      ${
        d.exonerationDutreil > 0
          ? `<div class="result" style="margin-bottom:12px">
               <div class="line"><span>Patrimoine économique transmis</span><b>${eur(d.patrimoineFoyer)}</b></div>
               <div class="line"><span>Exonération pacte Dutreil (−75 % titres éligibles, art. 787 B)</span><b style="color:var(--accent-2)">− ${eur(d.exonerationDutreil)}</b></div>
               <div class="line total"><span>Assiette taxable après Dutreil</span><b>${eur(d.patrimoineTaxable)}</b></div>
             </div>`
          : ""
      }
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
    mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { curve: "basis" } });
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
      <p class="muted">Renseigne les personnes. Mets la <b>date de naissance complète</b> (jour/mois/année) pour un âge exact, ou juste l'<b>année</b> si tu ne connais pas le jour. L'âge se calcule tout seul.</p>
      <table class="grid">
        <thead><tr><th>Nom</th><th>Rôle</th><th>Date de naissance</th><th>Année seule</th><th>Âge</th><th></th></tr></thead>
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
            <td><input type="date" class="naissance" value="${p.naissance || ""}"></td>
            <td><input class="annee" type="number" min="1900" max="${new Date().getFullYear()}" placeholder="1973" value="${p.annee ?? ""}" style="max-width:90px"></td>
            <td class="agecalc">${ageDe(p) != null ? ageDe(p) + " ans" : "—"}</td>
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
    const majAge = () => {
      const a = ageDe(personne(id));
      $(".agecalc", tr).textContent = a != null ? a + " ans" : "—";
    };
    // "input" ET "change" -> l'âge se met à jour en direct pendant la saisie
    ["input", "change"].forEach((ev) =>
      $(".naissance", tr).addEventListener(ev, (e) => {
        personne(id).naissance = e.target.value;
        save();
        majAge();
      })
    );
    $(".annee", tr).addEventListener("input", (e) => {
      const v = e.target.value;
      personne(id).annee = v === "" ? null : Number(v);
      save();
      majAge();
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

// ---------- Onglet Patrimoine (actifs / détentions / dettes) ----------
const CATEGORIES = [
  ["immobilier", "🏠 Immobilier"],
  ["sci", "🏢 SCI"],
  ["entreprise", "🏭 Capital entreprise"],
  ["liquidites", "💶 Liquidités / comptes"],
  ["titres", "📈 Titres / placements"],
  ["autre", "Autre"],
];
const opt = (list, sel) =>
  list.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`).join("");
const ownerList = () => [
  ...state.personnes.map((p) => [p.id, "👤 " + p.nom]),
  ...(state.actifs || []).map((a) => [a.id, "🏦 " + (a.libelle || a.id)]),
];
const actifList = () => (state.actifs || []).map((a) => [a.id, (a.libelle || a.id)]);

function renderPatrimoine() {
  const c = $("#tab-content");
  const A = state.actifs || [], D = state.detentions || [], X = state.dettes || [];
  const yr = new Date().getFullYear();
  const droits = [["PP", "Pleine propriété"], ["US", "Usufruit"], ["NP", "Nue-propriété"]];
  const detenteursDe = (aid) => D.map((d, i) => ({ d, i })).filter((o) => o.d.actifRef === aid);
  const dettesDe = (aid) => X.map((x, i) => ({ x, i })).filter((o) => o.x.cible === aid);

  const assetCard = (a, ai) => `
    <div class="asset-card">
      <div class="asset-head">
        <select class="f_cat" data-ai="${ai}">${opt(CATEGORIES, a.categorie)}</select>
        <input class="f_lib" data-ai="${ai}" placeholder="Libellé (ex : Résidence principale)" value="${a.libelle || ""}">
        <input class="f_val" data-ai="${ai}" inputmode="numeric" placeholder="Valeur €" value="${a.valeur || ""}" style="max-width:130px">
        <input class="f_an" data-ai="${ai}" type="number" min="1900" max="${yr}" placeholder="Année acquis." value="${a.annee ?? ""}" style="max-width:120px">
        ${a.categorie === "entreprise" ? `<label class="benef-chk"><input type="checkbox" class="f_dut" data-ai="${ai}" ${a.dutreil ? "checked" : ""}> Dutreil −75%</label>` : ""}
        <button class="danger-link" data-del="actif" data-ai="${ai}" title="Supprimer ce bien">🗑</button>
      </div>

      <div class="asset-sub">
        <div class="sub-title">🔗 Détenteurs <span class="muted small">— qui possède, quelle part, quel droit (démembrement)</span></div>
        ${detenteursDe(a.id).map(({ d, i }) => `
          <div class="mini-row">
            <select class="dd_prop" data-di="${i}">${opt(ownerList(), d.proprietaire)}</select>
            <input class="dd_part" data-di="${i}" inputmode="numeric" value="${d.part ?? ""}" placeholder="%" style="max-width:70px"><span class="muted">%</span>
            <select class="dd_droit" data-di="${i}">${opt(droits, d.droit)}</select>
            <button class="danger-link" data-del="detention" data-di="${i}">✕</button>
          </div>`).join("") || `<div class="muted small">Aucun détenteur pour l'instant.</div>`}
        <button class="btn small" data-add="detenteur" data-ai="${ai}">+ détenteur</button>
      </div>

      <div class="asset-sub">
        <div class="sub-title">💳 Dette liée <span class="muted small">— emprunt adossé à ce bien (réduit la valeur nette transmise)</span></div>
        ${dettesDe(a.id).map(({ x, i }) => `
          <div class="mini-row">
            <input class="xx_lib" data-xi="${i}" value="${x.libelle || ""}" placeholder="ex : Crédit ${a.libelle || "ce bien"}">
            <input class="xx_val" data-xi="${i}" inputmode="numeric" value="${x.montant || ""}" placeholder="Capital restant dû €">
            <button class="danger-link" data-del="dette" data-xi="${i}">✕</button>
          </div>`).join("") || `<div class="muted small">Aucune dette sur ce bien.</div>`}
        <button class="btn small" data-add="dette" data-ai="${ai}">+ dette sur ce bien</button>
      </div>
    </div>`;

  c.innerHTML = `
    <div class="card">
      <h2>🏦 Patrimoine — biens, détention & dettes</h2>
      <p class="muted small">Un bloc par bien (immobilier, SCI, entreprise, compte…). Sous chaque bien : <b>qui le détient</b> (avec démembrement) et <b>la dette qui lui est liée</b>. Pour une SCI qui détient un immeuble, ajoute la SCI comme détenteur de l'immeuble.</p>
      ${A.map(assetCard).join("") || `<p class="muted">Aucun bien pour l'instant. Ajoute ton premier bien ci-dessous.</p>`}
      <button class="btn primary" data-add="actif">+ Ajouter un bien</button>
    </div>
    <p class="muted small center">💾 Enregistrement automatique (local + cloud). Résultat dans <b>🏠 Résumé patrimonial</b>.</p>`;

  // --- Câblage par DÉLÉGATION (indices portés par data-attributes -> fiable) ---
  c.onclick = (e) => {
    const add = e.target.closest("[data-add]");
    if (add) {
      const kind = add.dataset.add;
      if (kind === "actif") {
        A.push({ id: uid(), libelle: "", categorie: "immobilier", valeur: 0, annee: null, dutreil: false });
        state.actifs = A;
      } else if (kind === "detenteur") {
        const a = A[+add.dataset.ai];
        D.push({ proprietaire: state.personnes.find((p) => p.role === "parent")?.id || state.personnes[0]?.id || "", actifRef: a.id, part: 100, droit: "PP" });
        state.detentions = D;
      } else if (kind === "dette") {
        const a = A[+add.dataset.ai];
        X.push({ id: uid(), libelle: "", montant: 0, cible: a.id });
        state.dettes = X;
      }
      save(); renderPatrimoine(); return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const kind = del.dataset.del;
      if (kind === "actif") {
        const removed = A[+del.dataset.ai];
        A.splice(+del.dataset.ai, 1);
        state.actifs = A;
        state.detentions = D.filter((d) => d.actifRef !== removed.id); // nettoie détentions liées
        state.dettes = X.filter((x) => x.cible !== removed.id);          // et dettes liées
      } else if (kind === "detention") {
        D.splice(+del.dataset.di, 1);
      } else if (kind === "dette") {
        X.splice(+del.dataset.xi, 1);
      }
      save(); renderPatrimoine(); return;
    }
  };

  c.oninput = (e) => {
    const t = e.target;
    if (t.dataset.ai != null) {
      const a = A[+t.dataset.ai];
      if (t.classList.contains("f_lib")) a.libelle = t.value;
      else if (t.classList.contains("f_val")) a.valeur = parseNum(t.value);
      else if (t.classList.contains("f_an")) a.annee = t.value === "" ? null : Number(t.value);
      else return;
      save();
    } else if (t.dataset.di != null && t.classList.contains("dd_part")) {
      D[+t.dataset.di].part = parseNum(t.value); save();
    } else if (t.dataset.xi != null) {
      const x = X[+t.dataset.xi];
      if (t.classList.contains("xx_lib")) x.libelle = t.value;
      else if (t.classList.contains("xx_val")) x.montant = parseNum(t.value);
      else return;
      save();
    }
  };

  c.onchange = (e) => {
    const t = e.target;
    if (t.dataset.ai != null) {
      const a = A[+t.dataset.ai];
      if (t.classList.contains("f_cat")) { a.categorie = t.value; save(); renderPatrimoine(); }
      else if (t.classList.contains("f_dut")) { a.dutreil = t.checked; save(); }
    } else if (t.dataset.di != null) {
      const d = D[+t.dataset.di];
      if (t.classList.contains("dd_prop")) d.proprietaire = t.value;
      else if (t.classList.contains("dd_droit")) d.droit = t.value;
      else return;
      save();
    }
  };
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
    const a = ageDe(personne($("#s_don").value));
    if (a != null) $("#s_age").value = a;
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
  const AV = state.av || [];
  const benefBoxes = (contrat, i) =>
    state.personnes
      .map((p) => {
        const checked = (contrat.beneficiaires || []).includes(p.id);
        const pctv = contrat.repartition?.[p.id] ?? "";
        return `<label class="benef-chk"><input type="checkbox" class="av_ben" data-i="${i}" data-p="${p.id}" ${checked ? "checked" : ""}> ${p.nom}${
          checked ? `<input class="av_pct" data-i="${i}" data-p="${p.id}" inputmode="numeric" value="${pctv}" placeholder="%" style="max-width:46px;margin-left:6px"><span class="muted">%</span>` : ""
        }</label>`;
      })
      .join("");
  c.innerHTML = `
    <div class="card">
      <h2>🛡️ Mes contrats d'assurance-vie</h2>
      <p class="muted small">Renseigne chaque contrat, son souscripteur, le capital, le régime (avant/après 70 ans) et coche les <b>bénéficiaires</b> (clause bénéficiaire).</p>
      ${AV.map((a, i) => `
        <div class="av-edit" data-i="${i}">
          <div class="form-row">
            <label>Libellé<input class="av_lib" value="${a.libelle || ""}" placeholder="ex : Contrat retraite"></label>
            <label>Banque / Assureur<input class="av_etab" value="${a.etablissement || ""}" placeholder="ex : Linxea, BNP…"></label>
            <label>Souscripteur<select class="av_sous">${opt(state.personnes.map((p) => [p.id, p.nom]), a.souscripteurId)}</select></label>
          </div>
          <div class="form-row">
            <label>Capital (€)<input class="av_mnt" value="${a.montant || ""}" inputmode="numeric"></label>
            <label>Année d'ouverture<input class="av_an" type="number" min="1950" max="${new Date().getFullYear()}" placeholder="ex : 2008" value="${a.annee ?? ""}"></label>
            <label>Régime des primes<select class="av_av70">${opt([["oui", "Avant 70 ans"], ["non", "Après 70 ans"]], a.avant70 ? "oui" : "non")}</select></label>
          </div>
          <div class="benef-row"><span class="muted small">Bénéficiaires :</span> ${benefBoxes(a, i)}
            <button class="av_equal btn small" data-i="${i}">répartir également</button>
          </div>
          <label style="display:block;margin-top:10px" class="muted small">Clause bénéficiaire (texte exact du contrat)
            <textarea class="av_clause" data-i="${i}" rows="2" placeholder="ex : mon conjoint, à défaut mes enfants nés ou à naître, vivants ou représentés, par parts égales, à défaut mes héritiers">${a.clause || ""}</textarea>
          </label>
          <div style="text-align:right;margin-top:6px"><button class="av_del danger-link" title="Supprimer">✕ supprimer ce contrat</button></div>
        </div>`).join("") || `<p class="muted">Aucun contrat. Ajoute-en un.</p>`}
      <button id="av_add" class="btn">+ Ajouter un contrat</button>
    </div>

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

  // --- Édition des contrats AV ---
  $$("#tab-content .av-edit").forEach((row) => {
    const i = +row.dataset.i;
    $(".av_lib", row).addEventListener("input", (e) => { AV[i].libelle = e.target.value; save(); });
    $(".av_etab", row).addEventListener("input", (e) => { AV[i].etablissement = e.target.value; save(); });
    $(".av_sous", row).addEventListener("change", (e) => { AV[i].souscripteurId = e.target.value; save(); });
    $(".av_mnt", row).addEventListener("input", (e) => { AV[i].montant = parseNum(e.target.value); save(); });
    $(".av_an", row).addEventListener("input", (e) => { AV[i].annee = e.target.value === "" ? null : Number(e.target.value); save(); });
    $(".av_av70", row).addEventListener("change", (e) => { AV[i].avant70 = e.target.value === "oui"; save(); });
    $(".av_clause", row).addEventListener("input", (e) => { AV[i].clause = e.target.value; save(); });
    $(".av_del", row).addEventListener("click", () => { AV.splice(i, 1); save(); renderAv(); });
  });
  $$("#tab-content .av_ben").forEach((cb) => cb.addEventListener("change", (e) => {
    const i = +e.target.dataset.i, pid = e.target.dataset.p;
    AV[i].beneficiaires = AV[i].beneficiaires || [];
    if (e.target.checked) { if (!AV[i].beneficiaires.includes(pid)) AV[i].beneficiaires.push(pid); }
    else {
      AV[i].beneficiaires = AV[i].beneficiaires.filter((x) => x !== pid);
      if (AV[i].repartition) delete AV[i].repartition[pid];
    }
    save();
    renderAv(); // pour afficher/masquer le champ %
  }));
  $$("#tab-content .av_pct").forEach((el) => el.addEventListener("input", (e) => {
    const i = +e.target.dataset.i, pid = e.target.dataset.p;
    AV[i].repartition = AV[i].repartition || {};
    AV[i].repartition[pid] = parseNum(e.target.value);
    save();
  }));
  $$("#tab-content .av_equal").forEach((btn) => btn.addEventListener("click", () => {
    const i = +btn.dataset.i;
    const bens = AV[i].beneficiaires || [];
    if (!bens.length) return;
    const part = Math.floor((100 / bens.length) * 10) / 10;
    AV[i].repartition = {};
    bens.forEach((pid, k) => (AV[i].repartition[pid] = k === bens.length - 1 ? +(100 - part * (bens.length - 1)).toFixed(1) : part));
    save();
    renderAv();
  }));
  $("#av_add").addEventListener("click", () => {
    AV.push({ id: uid(), libelle: "", souscripteurId: state.personnes.find((p) => p.role === "parent")?.id || "", montant: 0, avant70: true, beneficiaires: [] });
    state.av = AV; save(); renderAv();
  });

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

document.addEventListener("DOMContentLoaded", async () => {
  // Au démarrage : si le cloud est configuré, on garde la version LA PLUS RÉCENTE
  // (comparaison d'horodatage) — jamais écraser des saisies locales plus neuves.
  if (sync.getPassword()) {
    try {
      if (await sync.cloudAvailable()) {
        const remote = await sync.cloudLoad();
        const localTs = state._ts || 0;
        const remoteTs = (remote && remote._ts) || 0;
        if (remote && remoteTs > localTs) {
          // le cloud est strictement plus récent -> on l'adopte
          state = remote;
          localStorage.setItem(KEY, JSON.stringify(state));
        } else if (localTs > remoteTs && sync.isAuto()) {
          // local plus récent -> on pousse pour rattraper le cloud
          sync.cloudSave(state).catch(() => {});
        }
        // égalité (ex : anciennes données sans horodatage) -> on garde le local (jamais d'écrasement)
      }
    } catch { /* silencieux : on garde la version locale */ }
  }
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
