import {
  ABATTEMENTS, DON_FAMILIAL_SOMME, DELAI_RAPPEL_ANS,
  BAREMES_PAR_LIEN, LIBELLE_LIEN, calculDroits, tauxUsufruit,
  BAREME_LIGNE_DIRECTE, BAREME_USUFRUIT, AV_AVANT_70, AV_APRES_70,
} from "./data.js?v=37";
import { templateCSV, stateToCSV, csvToState } from "./csv.js?v=37";
import { buildMermaid, debrief } from "./graph.js?v=37";
import * as sync from "./sync.js?v=37";
import { askAI } from "./ai.js?v=37";

// ---------- Utilitaires ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const eur = (n) =>
  (n ?? 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(0) + " %";
const parseNum = (v) => Number(String(v).replace(/[^\d.-]/g, "")) || 0;
// Accepte "16.2", "16,2" ou une fraction "81/500" -> renvoie un % (16.2)
const parsePart = (v) => {
  const s = String(v).trim().replace(",", ".");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m) { const a = parseFloat(m[1]), b = parseFloat(m[2]); return b ? +((a / b) * 100).toFixed(2) : 0; }
  return parseNum(v);
};

function ageAu(naissance, dateRef = new Date()) {
  if (!naissance) return null;
  const n = new Date(naissance);
  let age = dateRef.getFullYear() - n.getFullYear();
  const m = dateRef.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && dateRef.getDate() < n.getDate())) age--;
  return age;
}
// Année de naissance : la DATE complète prime (plus précise), puis année seule, puis âge
function birthYearOf(p) {
  if (!p) return null;
  if (p.naissance) { const y = new Date(p.naissance).getFullYear(); if (Number.isFinite(y)) return y; }
  if (p.annee) return Number(p.annee);
  if (p.age != null && p.age !== "") return new Date().getFullYear() - Number(p.age);
  return null;
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
  try {
    sync.scheduleAutoSave(() => state, (s, info) => { try { cloudStatusCb?.(s, info); } catch {} });
  } catch { /* la synchro cloud ne doit jamais casser l'app */ }
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
  { id: "conseil", label: "🤖 Conseil & optimisation" },
  { id: "famille", label: "👪 Famille" },
  { id: "patrimoine", label: "🏦 Patrimoine" },
  { id: "entreprise", label: "🏭 Entreprise" },
  { id: "assurancevie", label: "🛡️ Assurance-vie" },
  { id: "banques", label: "🏛️ Par banque" },
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
    conseil: renderConseil,
    famille: renderFamille,
    patrimoine: renderPatrimoine,
    entreprise: renderEntreprise,
    donations: renderDonations,
    abattements: renderAbattements,
    simulateur: renderSimulateur,
    assurancevie: renderAv,
    banques: renderBanques,
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

// Export d'un RÉSUMÉ lisible en CSV (synthèse, exposition, droits par enfant, AV, donations)
function exporterResume() {
  const d = debrief(state);
  const euro = (n) => Math.round(n || 0).toLocaleString("fr-FR") + " €";
  const rows = [];
  const push = (...cells) => rows.push(cells);

  push("RÉSUMÉ PATRIMONIAL");
  push("Édité le", new Date().toLocaleDateString("fr-FR"));
  push("Régime matrimonial", REGIME_LABEL[state.regime || ""] || "non précisé");
  push("");
  push("SYNTHÈSE");
  push("Patrimoine net du foyer", euro(d.patrimoineFoyer));
  push("Dettes totales", euro(d.totalDettes));
  if (d.exonerationDutreil > 0) push("Exonération Dutreil (−75%)", euro(d.exonerationDutreil));
  push("Assiette taxable (succession)", euro(d.patrimoineTaxable));
  push("Droits de succession estimés (décès des 2 parents)", euro(d.droitsSuccessionEstimes));
  push("");
  const expoCsv = {};
  Object.entries(d.parCategorie).forEach(([k, v]) => { const key = k === "sci" ? "immobilier (dont SCI)" : k; expoCsv[key] = (expoCsv[key] || 0) + v; });
  const avTot = (d.avAvant70 || 0) + (d.avApres70 || 0);
  if (avTot > 0) expoCsv["assurance-vie"] = (expoCsv["assurance-vie"] || 0) + avTot;
  const totalCat = Object.values(expoCsv).reduce((s, v) => s + v, 0) || 1;
  push("EXPOSITION PAR CATÉGORIE", "Valeur", "Part");
  Object.entries(expoCsv).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => push(k, euro(v), (v / totalCat * 100).toFixed(0) + " %"));
  push("");
  push("PATRIMOINE PAR PERSONNE", "Rôle", "Montant net");
  state.personnes.forEach((p) => push(p.nom, p.role, euro(d.parPersonne[p.id] || 0)));
  push("");
  push("SI DÉCÈS AUJOURD'HUI — PAR ENFANT", "Part reçue", "Abattement", "Base taxable", "Droits à payer", "Net perçu");
  (d.successionParEnfant || []).forEach((e) => push(e.nom, euro(e.recu), euro(e.abattement), euro(e.base), euro(e.droits), euro(e.net)));
  push("TOTAL DROITS", "", "", "", euro(d.droitsSuccessionEstimes), "");
  if (d.scenarios) {
    push("");
    push("SCÉNARIOS DE TRANSMISSION", "Total droits enfants");
    push("Communauté universelle + attribution intégrale (1 abattement)", euro(d.scenarios.attribution.total));
    push("Transmission à chaque décès (2 abattements)", euro(d.scenarios.progressif.total));
    push("Décès simultané (référence)", euro(d.scenarios.simultane.total));
  }
  push("");
  push("ASSURANCE-VIE", "Banque", "Souscripteur(s)", "Capital", "Régime primes", "Bénéficiaires");
  (state.av || []).forEach((a) => {
    const bens = (a.beneficiaires || []).map((b) => { const nom = personne(b)?.nom || b; const pc = a.repartition?.[b]; return pc ? `${nom} ${pc}%` : nom; }).join(" / ");
    const sous = (personne(a.souscripteurId)?.nom || "") + (a.cosouscripteurId ? " & " + (personne(a.cosouscripteurId)?.nom || "") : "");
    push(a.libelle || a.id, a.etablissement || "", sous, euro(a.montant), a.avant70 ? "avant 70 ans" : "après 70 ans", bens);
  });
  push("");
  push("DONATIONS RÉALISÉES", "Date", "Donateur", "Bénéficiaire", "Montant", "Statut");
  state.donations.forEach((x) => {
    const purge = anneesEcoulees(x.date) >= DELAI_RAPPEL_ANS;
    push("", x.date, personne(x.donateurId)?.nom || "", personne(x.beneficiaireId)?.nom || "", euro(x.montant), purge ? "purgée (>15 ans)" : "rapportable");
  });

  const esc = (s) => { s = String(s ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  download("resume-patrimonial.csv", rows.map((r) => r.map(esc).join(",")).join("\n"));
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

  const status = (msg, color = "var(--muted)") => { const el = $("#cl_status"); if (el) el.innerHTML = `<span style="color:${color}">${msg}</span>`; };
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

  const DROIT_LBL = { PP: "Pleine propriété", US: "Usufruit", NP: "Nue-propriété" };
  const droitBadge = (dr) => dr === "PP" ? "" : `<span class="badge warn">${DROIT_LBL[dr] || dr}</span>`;
  const persoDetailCard = state.personnes.map((p) => {
    const items = (d.parPersonneDetail[p.id] || []).slice().sort((a, b) => b.valeur - a.valeur);
    const bienTotal = d.parPersonne[p.id] || 0;
    // Assurance-vie attribuée : souscripteur (ou 50/50 en co-adhésion)
    const avItems = [];
    (state.av || []).forEach((a) => {
      const m = Number(a.montant) || 0;
      if (a.cosouscripteurId && (a.souscripteurId === p.id || a.cosouscripteurId === p.id)) avItems.push({ lib: a.libelle || "AV", val: m / 2, co: true });
      else if (!a.cosouscripteurId && a.souscripteurId === p.id) avItems.push({ lib: a.libelle || "AV", val: m, co: false });
    });
    const avPerso = avItems.reduce((s, i) => s + i.val, 0);
    const grand = bienTotal + avPerso;
    const bienRows = items.map((it) => `<tr>
      <td>${CAT_LOOKUP[it.categorie] || it.categorie} · ${it.libelle}</td>
      <td>${it.part} %</td>
      <td>${it.droit === "PP" ? '<span class="muted small">pleine propriété</span>' : `${droitBadge(it.droit)} <span class="muted small">${Math.round(it.fraction * 100)} % (669, usuf. ${it.usuAge} ans)</span>`}</td>
      <td style="text-align:right"><b>${eur(it.valeur)}</b>${it.droit !== "PP" ? `<div class="muted small">${it.part}% × ${Math.round(it.fraction * 100)}%</div>` : ""}</td>
    </tr>`).join("");
    const avRows = avItems.map((it) => `<tr style="background:rgba(224,72,154,.06)">
      <td>🛡️ ${it.lib}${it.co ? ' <span class="muted small">(co-adh. ½)</span>' : ""}</td>
      <td colspan="2"><span class="muted small">assurance-vie · hors succession</span></td>
      <td style="text-align:right"><b>${eur(it.val)}</b></td>
    </tr>`).join("");
    const roleLbl = p.role === "parent" ? "Parent" : p.role === "enfant" ? "Enfant" : p.role;
    return `<details class="perso-details" open>
      <summary class="perso-sum">
        <span><b style="font-size:15px">${p.nom}</b> <span class="badge ${p.role === "parent" ? "warn" : "ok"}">${roleLbl}</span> <span class="muted small">${items.length} bien(s)${avItems.length ? " + AV" : ""}</span></span>
        <b style="color:var(--accent);font-size:16px">${eur(grand)}</b>
      </summary>
      ${(items.length || avItems.length)
        ? `<table class="grid"><thead><tr><th>Bien / actif détenu</th><th>Quote-part</th><th>Droit</th><th style="text-align:right">Valeur détenue</th></tr></thead><tbody>
          ${bienRows}${avRows}
          </tbody>
          <tfoot>
            ${avItems.length ? `<tr><td colspan="3" class="muted small">dont biens ${eur(bienTotal)} + assurance-vie ${eur(avPerso)}</td><td></td></tr>` : ""}
          </tfoot></table>`
        : `<div class="muted small" style="margin-top:6px">Rien de détenu pour l'instant.</div>`}
    </details>`;
  }).join("");
  // Exposition : SCI regroupées avec l'immobilier, assurance-vie ajoutée comme classe d'actif
  const hasSci = (d.parCategorie.sci || 0) > 0;
  const avTotal = (d.avAvant70 || 0) + (d.avApres70 || 0);
  const expo = {};
  Object.entries(d.parCategorie).forEach(([k, v]) => {
    const key = k === "sci" ? "immobilier" : k;
    expo[key] = (expo[key] || 0) + v;
  });
  if (avTotal > 0) expo.assurancevie = (expo.assurancevie || 0) + avTotal;
  const CAT_LBL = { immobilier: hasSci ? "🏠 Immobilier (dont SCI)" : "🏠 Immobilier", entreprise: "🏭 Entreprise", liquidites: "💶 Liquidités", titres: "📈 Titres", assurancevie: "🛡️ Assurance-vie", autre: "Autre" };
  const totalCat = Object.values(expo).reduce((s, v) => s + v, 0) || 1;
  const catRows = Object.entries(expo)
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
    <div class="card hero">
      <div>
        <div class="muted small">Patrimoine global du foyer${avTotal > 0 ? " (avec assurance-vie)" : ""}</div>
        <div class="hero-total">${eur(d.patrimoineFoyer + avTotal)}</div>
        <div class="muted small">${avTotal > 0 ? `dont biens ${eur(d.patrimoineFoyer)} + assurance-vie ${eur(avTotal)} · ` : ""}Régime : <b>${REGIME_LABEL[d.regime] || "non précisé"}</b> · Droits succession estimés (hors AV) : <b>${eur(d.droitsSuccessionEstimes)}</b></div>
      </div>
      <button id="exp_resume" class="btn primary">⬇ Exporter le résumé (CSV)</button>
    </div>
    ${
      hasData
        ? ""
        : `<div class="card"><b>Aucune donnée patrimoniale.</b> Commence par les onglets <b>👪 Famille</b> puis <b>🏦 Patrimoine</b>.</div>`
    }
    <div class="card">
      <h2>👥 Qui possède quoi — détail par personne</h2>
      <p class="muted small">Répartition détenue par chaque personne (biens en direct + parts de SCI/société, avec démembrement). Total foyer : <b>${eur(d.patrimoineFoyer)}</b>.</p>
      ${persoDetailCard}
    </div>

    <div class="grid-2">
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
                  <td>${personne(a.souscripteurId)?.nom || a.souscripteurId || "?"}${a.cosouscripteurId ? " & " + (personne(a.cosouscripteurId)?.nom || "") + " <span class=\"muted small\">(co-adh.)</span>" : ""}</td>
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

    ${
      (d.avBeneficiaires || []).length
        ? `<div class="card">
      <h2>🛡️ Assurance-vie — ce que touche chaque bénéficiaire (990 I)</h2>
      <p class="muted small">Primes versées <b>avant 70 ans</b> : abattement de 152 500 € <b>par bénéficiaire</b>, puis 20 % jusqu'à 700 700 € et 31,25 % au-delà. Capital réparti selon la clause bénéficiaire de chaque contrat.</p>
      <table class="grid"><thead><tr>
        <th>Bénéficiaire</th><th>Capital reçu</th><th>Abattement</th><th>Base taxable</th><th>Droits (990 I)</th><th>Net perçu</th>
      </tr></thead><tbody>
      ${d.avBeneficiaires.map((x) => `<tr>
        <td><b>${x.nom}</b></td>
        <td>${eur(x.capital)}</td>
        <td>− ${eur(x.abattement)}</td>
        <td>${eur(x.base)}</td>
        <td style="color:var(--warn)"><b>${eur(x.droits)}</b></td>
        <td>${eur(x.net)}</td>
      </tr>`).join("")}
      </tbody>
      <tfoot><tr>
        <th>Total</th><td>${eur(d.avBeneficiaires.reduce((s, x) => s + x.capital, 0))}</td><td></td><td></td>
        <td style="color:var(--warn)"><b>${eur(d.totalDroitsAV)}</b></td><td></td>
      </tr></tfoot>
      </table>
      ${d.apres70Reintegre > 0 ? `<p class="muted small" style="margin-top:10px">💡 Primes versées <b>après 70 ans</b> : abattement global de 30 500 €, l'excédent (<b>${eur(d.apres70Reintegre)}</b>) est réintégré à la base successorale ci-dessous (art. 757 B) et taxé au barème succession.</p>` : ""}
    </div>`
        : ""
    }

    <div class="card">
      <h2>💰 Total des droits à payer & base successorale globale</h2>
      <div class="result">
        <div class="line"><span>Assiette taxable des biens (après Dutreil)</span><b>${eur(d.patrimoineTaxable)}</b></div>
        ${d.apres70Reintegre > 0 ? `<div class="line"><span>+ Assurance-vie après 70 ans réintégrée (art. 757 B)</span><b>+ ${eur(d.apres70Reintegre)}</b></div>` : ""}
        <div class="line total"><span>📊 Base successorale globale</span><b>${eur(d.baseSuccessoraleGlobale)}</b></div>
        <div class="line" style="margin-top:8px"><span>Droits de succession (sur base globale)</span><b style="color:var(--warn)">${eur(d.droitsSuccessionGlobaux)}</b></div>
        <div class="line"><span>Droits assurance-vie avant 70 ans (990 I)</span><b style="color:var(--warn)">${eur(d.totalDroitsAV)}</b></div>
        <div class="line total"><span>💸 TOTAL des droits à payer</span><b style="color:var(--danger);font-size:18px">${eur(d.totalDroitsTous)}</b></div>
      </div>
    </div>

    ${
      d.scenarios
        ? (() => {
            const s = d.scenarios;
            const match = d.regime === "universelle_attribution" ? "attribution" : (d.regime && d.regime !== "" ? "progressif" : null);
            const best = ["attribution", "progressif", "simultane"].reduce((a, b) => (s[b].total < s[a].total ? b : a));
            const row = (key, titre, sous) => `<tr ${key === match ? 'style="background:var(--accent-soft)"' : ""}>
              <td><b>${titre}</b><br><span class="muted small">${sous}</span></td>
              <td style="color:var(--warn);white-space:nowrap"><b>${eur(s[key].total)}</b></td>
              <td>${key === match ? '<span class="badge warn">votre régime</span> ' : ""}${key === best ? '<span class="badge ok">le moins coûteux</span>' : ""}</td>
            </tr>`;
            return `<div class="card">
              <h2>⚖️ Scénarios de transmission aux enfants</h2>
              <p class="muted small">Selon l'ordre des décès et le régime matrimonial, le coût fiscal total pour les enfants change fortement. Estimation ligne directe sur l'assiette taxable (${eur(d.patrimoineTaxable)}), hors assurance-vie.</p>
              <table class="grid"><thead><tr><th>Scénario</th><th>Total droits enfants</th><th></th></tr></thead><tbody>
                ${row("attribution", "Communauté universelle + attribution intégrale", "Tout au conjoint au 1er décès (0 droit), enfants héritent au 2nd → 1 seul abattement de 100 000 €")}
                ${row("progressif", "Transmission à chaque décès", "Moitié au 1er décès, moitié au 2nd → 2 abattements + tranches basses")}
                ${row("simultane", "Décès simultané des 2 parents", "Référence : 2 abattements, une seule transmission")}
              </tbody></table>
              <p class="muted small">💡 L'attribution intégrale <b>protège le conjoint</b> mais coûte le plus aux enfants (un seul abattement, base pleine). Transmettre progressivement (ou anticiper par donations démembrées) minimise les droits. À arbitrer avec le notaire.</p>
            </div>`;
          })()
        : ""
    }

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">🗺️ Organigramme patrimonial</h2>
        <button id="dl_svg" class="btn ghost">⬇ Exporter l'image (SVG)</button>
      </div>
      <div id="mermaid-box" class="mermaid-box"><div class="muted">Génération du schéma…</div></div>
      <p class="muted small">Traits pleins = pleine propriété · pointillés = démembrement (US/NP) · flèches épaisses = donations réalisées.</p>
    </div>`;

  // Rendu Mermaid (import dynamique depuis CDN)
  $("#exp_resume")?.addEventListener("click", exporterResume);

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
    </div>

    <div class="card">
      <h3>💍 Régime matrimonial des parents</h3>
      <select id="regime" style="max-width:520px">${opt(REGIMES, state.regime || "")}</select>
      <p class="muted small" id="regime-note" style="margin-top:8px">${REGIME_NOTE[state.regime || ""]}</p>
    </div>`;

  $("#regime")?.addEventListener("change", (e) => {
    state.regime = e.target.value;
    save();
    $("#regime-note").textContent = REGIME_NOTE[state.regime] || "";
  });

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
const CAT_LOOKUP = Object.fromEntries(CATEGORIES);
const collapsedCats = new Set(); // catégories repliées (état d'affichage, non sauvegardé)

const ETABLISSEMENTS = ["Generali", "Société Générale", "BNP Paribas", "Aviva", "Trading 212", "AXA", "Natixis", "Coinbase", "Allianz"];
const datalistEtabs = () => `<datalist id="etabs">${ETABLISSEMENTS.map((e) => `<option value="${e}">`).join("")}</datalist>`;
const CAT_A_BANQUE = new Set(["titres", "liquidites"]); // catégories où une banque/courtier a du sens

const REGIMES = [
  ["", "— non précisé —"],
  ["acquets", "Communauté réduite aux acquêts (régime légal)"],
  ["universelle", "Communauté universelle"],
  ["universelle_attribution", "Communauté universelle + attribution intégrale au survivant"],
  ["separation", "Séparation de biens"],
  ["participation", "Participation aux acquêts"],
];
const REGIME_LABEL = Object.fromEntries([
  ["", "non précisé"],
  ["acquets", "Communauté réduite aux acquêts"],
  ["universelle", "Communauté universelle"],
  ["universelle_attribution", "Communauté universelle + attribution intégrale"],
  ["separation", "Séparation de biens"],
  ["participation", "Participation aux acquêts"],
]);
const REGIME_NOTE = {
  "": "Précise le régime : il change ce qui entre dans la succession à chaque décès.",
  acquets: "Chaque parent transmet sa moitié de communauté + ses biens propres. Les enfants héritent dès le 1er décès (avec abattement de ce parent).",
  universelle: "Tout le patrimoine est commun. Sans clause d'attribution, la moitié revient aux enfants au 1er décès.",
  universelle_attribution: "⚠️ Au 1er décès, TOUT revient au conjoint survivant sans droits. Mais les enfants n'héritent qu'au 2nd décès : ils perdent l'abattement (100 000 €) du 1er parent et paient plus au final. Arbitrage protection du conjoint ↔ coût fiscal — à valider avec le notaire.",
  separation: "Chaque parent ne transmet que ses biens propres. Bien identifier qui possède quoi (onglet Patrimoine).",
  participation: "Comme la séparation pendant le mariage ; une créance de participation peut naître au décès.",
};

function renderPatrimoine() {
  const c = $("#tab-content");
  const A = state.actifs || [], D = state.detentions || [], X = state.dettes || [];
  const yr = new Date().getFullYear();
  const droits = [["PP", "Pleine propriété"], ["US", "Usufruit"], ["NP", "Nue-propriété"]];
  const detenteursDe = (aid) => D.map((d, i) => ({ d, i })).filter((o) => o.d.actifRef === aid);
  const dettesDe = (aid) => X.map((x, i) => ({ x, i })).filter((o) => o.x.cible === aid);

  const pvText = (a) => {
    const bits = [];
    if (a.categorie === "immobilier" && a.prixAcq && a.valeur) bits.push(`Plus-value latente : <b>${eur(a.valeur - a.prixAcq)}</b> (achat ${eur(a.prixAcq)} → marché ${eur(a.valeur)})`);
    if ((a.categorie === "immobilier" || a.categorie === "sci") && a.surface && a.valeur) bits.push(`<b>${eur(Math.round(a.valeur / a.surface))}/m²</b> (${a.surface} m²)`);
    return bits.join(" · ");
  };

  const assetCard = (a, ai) => `
    <div class="asset-card">
      <div class="asset-head">
        <select class="f_cat" data-ai="${ai}">${opt(CATEGORIES, a.categorie)}</select>
        <input class="f_lib" data-ai="${ai}" placeholder="Libellé (ex : Résidence principale)" value="${a.libelle || ""}">
        <input class="f_val" data-ai="${ai}" inputmode="numeric" placeholder="${a.categorie === "immobilier" ? "Valeur marchande €" : "Valeur €"}" value="${a.valeur || ""}" style="max-width:150px">
        ${a.categorie === "immobilier" ? `<input class="f_pxacq" data-ai="${ai}" inputmode="numeric" placeholder="Prix d'achat €" value="${a.prixAcq ?? ""}" style="max-width:130px">` : ""}
        ${(a.categorie === "immobilier" || a.categorie === "sci") ? `<input class="f_surface" data-ai="${ai}" inputmode="numeric" placeholder="Surface m²" value="${a.surface ?? ""}" style="max-width:110px">` : ""}
        ${CAT_A_BANQUE.has(a.categorie) ? `<input class="f_etab" data-ai="${ai}" list="etabs" placeholder="Banque / Courtier" value="${a.etablissement || ""}" style="max-width:160px">` : ""}
        <input class="f_an" data-ai="${ai}" type="number" min="1900" max="${yr}" placeholder="Année acquis." value="${a.annee ?? ""}" style="max-width:120px">
        ${a.categorie === "entreprise" ? `<label class="benef-chk"><input type="checkbox" class="f_dut" data-ai="${ai}" ${a.dutreil ? "checked" : ""}> Dutreil −75%</label>` : ""}
        <button class="verif-btn ${a.verifie ? "on" : ""}" data-verif="${ai}" title="Marquer comme vérifié">${a.verifie ? "✓ OK" : "OK"}</button>
        <button class="danger-link" data-del="actif" data-ai="${ai}" title="Supprimer ce bien">🗑</button>
      </div>
      <div class="pv-line muted small" data-ai="${ai}" style="margin:-4px 0 8px">${pvText(a)}</div>

      <div class="asset-sub">
        <div class="sub-title">🔗 Détenteurs <span class="muted small">— qui possède, quelle part, quel droit (démembrement)</span></div>
        ${detenteursDe(a.id).map(({ d, i }) => `
          <div class="mini-row">
            <select class="dd_prop" data-di="${i}">${opt(ownerList(), d.proprietaire)}</select>
            <input class="dd_part" data-di="${i}" value="${d.part ?? ""}" placeholder="% ou 81/500" style="max-width:110px"><span class="muted">%</span>
            <select class="dd_droit" data-di="${i}">${opt(droits, d.droit)}</select>
            <button class="danger-link" data-del="detention" data-di="${i}">✕</button>
          </div>`).join("") || `<div class="muted small">Aucun détenteur pour l'instant.</div>`}
        <button class="btn small" data-add="detenteur" data-ai="${ai}">+ détenteur</button>
        ${detenteursDe(a.id).some((o) => o.d.droit !== "PP") ? `<label class="muted small" style="display:flex;gap:6px;align-items:center;margin-top:8px">Année du démembrement (fige le barème 669) <input class="f_demyr" data-ai="${ai}" type="number" min="1990" max="${yr}" placeholder="ex : 2025" value="${a.demembrementAnnee ?? ""}" style="max-width:110px"></label>` : ""}
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

  // Regroupement des biens par catégorie (repliables)
  const items = A.map((a, ai) => ({ a, ai }));
  const catsPresentes = CATEGORIES.map(([k]) => k).filter((k) => items.some((it) => it.a.categorie === k));
  const groupesHtml = catsPresentes.map((key) => {
    const grp = items.filter((it) => it.a.categorie === key);
    const total = grp.reduce((s, it) => s + (Number(it.a.valeur) || 0), 0);
    const dette = (state.dettes || []).filter((x) => grp.some((it) => it.a.id === x.cible)).reduce((s, x) => s + (Number(x.montant) || 0), 0);
    const net = total - dette;
    const collapsed = collapsedCats.has(key);
    return `<div class="cat-group">
      <button class="cat-header" data-togglecat="${key}">
        <span>${CAT_LOOKUP[key] || key} <span class="muted small">· ${grp.length} bien(s) · net ${eur(net)}</span></span>
        <span class="chevron">${collapsed ? "▸" : "▾"}</span>
      </button>
      ${collapsed ? "" : `<div class="cat-body">${grp.map((it) => assetCard(it.a, it.ai)).join("")}</div>`}
    </div>`;
  }).join("");

  c.innerHTML = `
    ${datalistEtabs()}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">🏦 Patrimoine — biens, détention & dettes</h2>
        ${A.length ? `<div style="display:flex;gap:8px"><button class="btn small" id="collapse_all">Tout replier</button><button class="btn small" id="expand_all">Tout déplier</button></div>` : ""}
      </div>
      <p class="muted small">Regroupé par catégorie (clique un en-tête pour replier/déplier). Sous chaque bien : <b>qui le détient</b> (démembrement) et <b>la dette liée</b>.</p>
      ${groupesHtml || `<p class="muted">Aucun bien pour l'instant. Ajoute ton premier bien ci-dessous.</p>`}
      <button class="btn primary" data-add="actif" style="margin-top:6px">+ Ajouter un bien</button>
    </div>
    <p class="muted small center">💾 Enregistrement automatique (local + cloud). Résultat dans <b>🏠 Résumé patrimonial</b>.</p>`;

  // --- Câblage par DÉLÉGATION (indices portés par data-attributes -> fiable) ---
  c.onclick = (e) => {
    // Repli/dépli des groupes de catégories
    const catBtn = e.target.closest("[data-togglecat]");
    if (catBtn) {
      const k = catBtn.dataset.togglecat;
      collapsedCats.has(k) ? collapsedCats.delete(k) : collapsedCats.add(k);
      renderPatrimoine(); return;
    }
    if (e.target.closest("#collapse_all")) { catsPresentes.forEach((k) => collapsedCats.add(k)); renderPatrimoine(); return; }
    if (e.target.closest("#expand_all")) { collapsedCats.clear(); renderPatrimoine(); return; }
    const verif = e.target.closest("[data-verif]");
    if (verif) { const a = A[+verif.dataset.verif]; a.verifie = !a.verifie; save(); renderPatrimoine(); return; }

    const add = e.target.closest("[data-add]");
    if (add) {
      const kind = add.dataset.add;
      if (kind === "actif") {
        A.push({ id: uid(), libelle: "", categorie: "immobilier", valeur: 0, annee: null, dutreil: false });
        state.actifs = A;
        collapsedCats.delete("immobilier"); // déplie le groupe pour que le nouveau bien soit visible
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
      const ai = +t.dataset.ai, a = A[ai];
      if (t.classList.contains("f_lib")) a.libelle = t.value;
      else if (t.classList.contains("f_val")) a.valeur = parseNum(t.value);
      else if (t.classList.contains("f_pxacq")) a.prixAcq = t.value === "" ? null : parseNum(t.value);
      else if (t.classList.contains("f_surface")) a.surface = t.value === "" ? null : parseNum(t.value);
      else if (t.classList.contains("f_etab")) a.etablissement = t.value;
      else if (t.classList.contains("f_demyr")) { a.demembrementAnnee = t.value === "" ? null : Number(t.value); save(); return; }
      else if (t.classList.contains("f_an")) a.annee = t.value === "" ? null : Number(t.value);
      else return;
      // met à jour la plus-value / €m² affiché sans re-render (garde le focus)
      if (t.classList.contains("f_val") || t.classList.contains("f_pxacq") || t.classList.contains("f_surface")) {
        const pv = c.querySelector(`.pv-line[data-ai="${ai}"]`);
        if (pv) pv.innerHTML = pvText(a);
      }
      save();
    } else if (t.dataset.di != null && t.classList.contains("dd_part")) {
      D[+t.dataset.di].part = parsePart(t.value); save();
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
    ${datalistEtabs()}
    <div class="card">
      <h2>🛡️ Mes contrats d'assurance-vie</h2>
      <p class="muted small">Renseigne chaque contrat, son souscripteur, le capital, le régime (avant/après 70 ans) et coche les <b>bénéficiaires</b> (clause bénéficiaire).</p>
      ${AV.map((a, i) => `
        <div class="av-edit" data-i="${i}">
          <div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="verif-btn av_verif ${a.verifie ? "on" : ""}" title="Marquer comme vérifié">${a.verifie ? "✓ OK" : "OK"}</button></div>
          <div class="form-row">
            <label>Libellé<input class="av_lib" value="${a.libelle || ""}" placeholder="ex : Contrat retraite"></label>
            <label>Banque / Assureur<input class="av_etab" list="etabs" value="${a.etablissement || ""}" placeholder="ex : Generali, AXA…"></label>
            <label>Souscripteur<select class="av_sous">${opt(state.personnes.map((p) => [p.id, p.nom]), a.souscripteurId)}</select></label>
            <label>Co-souscripteur (co-adhésion)<select class="av_cosous"><option value="" ${!a.cosouscripteurId ? "selected" : ""}>— aucun —</option>${opt(state.personnes.map((p) => [p.id, p.nom]), a.cosouscripteurId)}</select></label>
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
    $(".av_cosous", row).addEventListener("change", (e) => { AV[i].cosouscripteurId = e.target.value || null; save(); });
    $(".av_mnt", row).addEventListener("input", (e) => { AV[i].montant = parseNum(e.target.value); save(); });
    $(".av_an", row).addEventListener("input", (e) => { AV[i].annee = e.target.value === "" ? null : Number(e.target.value); save(); });
    $(".av_av70", row).addEventListener("change", (e) => { AV[i].avant70 = e.target.value === "oui"; save(); });
    $(".av_clause", row).addEventListener("input", (e) => { AV[i].clause = e.target.value; save(); });
    $(".av_verif", row).addEventListener("click", () => { AV[i].verifie = !AV[i].verifie; save(); renderAv(); });
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
// ---------- Onglet Entreprise (Dutreil + démembrement des titres) ----------
const FORMES = [["", "— forme —"], ["sarl", "SARL"], ["sas", "SAS"], ["sa", "SA"], ["sci", "SCI (à l'IS)"], ["holding", "Holding"], ["ei", "Entreprise individuelle"], ["autre", "Autre"]];

function renderEntreprise() {
  const c = $("#tab-content");
  const A = state.actifs || [], D = state.detentions || [];
  const ents = A.map((a, ai) => ({ a, ai })).filter((o) => o.a.categorie === "entreprise");
  const droits = [["PP", "Pleine propriété"], ["US", "Usufruit"], ["NP", "Nue-propriété"]];
  const detOf = (aid) => D.map((d, i) => ({ d, i })).filter((o) => o.d.actifRef === aid);

  const card = ({ a, ai }) => {
    const dets = detOf(a.id);
    const valeur = Number(a.valeur) || 0;
    const usDet = dets.find((o) => o.d.droit === "US");
    const usPers = usDet ? personne(usDet.d.proprietaire) : null;
    const by = birthYearOf(usPers);
    const anneeRef = a.demembrementAnnee ? Number(a.demembrementAnnee) : new Date().getFullYear();
    const age = by != null ? anneeRef - by : null;
    const tUS = age != null ? tauxUsufruit(age) : null;
    const npVal = tUS != null ? valeur * (1 - tUS) : null;
    const sommeParts = dets.reduce((s, o) => s + (Number(o.d.part) || 0), 0);
    return `<div class="asset-card">
      <div class="form-row">
        <label>Nom de la société<input class="e_lib" data-ai="${ai}" value="${a.libelle || ""}" placeholder="ex : Ma Holding SAS"></label>
        <label>Forme juridique<select class="e_forme" data-ai="${ai}">${opt(FORMES, a.forme || "")}</select></label>
        <label>Valeur des titres (€)<input class="e_val" data-ai="${ai}" inputmode="numeric" value="${a.valeur || ""}"></label>
        <label>Année acquis./création<input class="e_an" data-ai="${ai}" type="number" min="1900" max="${new Date().getFullYear()}" value="${a.annee ?? ""}"></label>
      </div>
      <div class="benef-row">
        <label class="benef-chk"><input type="checkbox" class="e_dut" data-ai="${ai}" ${a.dutreil ? "checked" : ""}> Pacte Dutreil (exonération 75 %)</label>
        ${a.dutreil ? `<label style="max-width:200px">Année engagement collectif<input class="e_dutan" data-ai="${ai}" type="number" min="1990" max="${new Date().getFullYear()}" value="${a.dutreilAnnee ?? ""}"></label>` : ""}
        <label style="max-width:220px">Année du démembrement<input class="e_demyr" data-ai="${ai}" type="number" min="1990" max="${new Date().getFullYear()}" placeholder="fige le barème 669" value="${a.demembrementAnnee ?? ""}"></label>
        <button class="verif-btn ${a.verifie ? "on" : ""}" data-verif="${ai}" title="Marquer comme vérifié" style="margin-left:auto">${a.verifie ? "✓ OK" : "OK"}</button>
        <button class="danger-link" data-del="entreprise" data-ai="${ai}" title="Supprimer">🗑</button>
      </div>

      <div class="asset-sub">
        <div class="sub-title">🔗 Détention des titres <span class="muted small">— associés, avec démembrement usufruit / nue-propriété</span></div>
        ${dets.map(({ d, i }) => `
          <div class="mini-row">
            <select class="ed_prop" data-di="${i}">${opt(ownerList(), d.proprietaire)}</select>
            <input class="ed_part" data-di="${i}" value="${d.part ?? ""}" placeholder="% ou 81/500" style="max-width:110px"><span class="muted">%</span>
            <select class="ed_droit" data-di="${i}">${opt(droits, d.droit)}</select>
            <button class="danger-link" data-del="entdet" data-di="${i}">✕</button>
          </div>`).join("") || `<div class="muted small">Aucun détenteur.</div>`}
        <button class="btn small" data-add="entdet" data-ai="${ai}">+ associé / détenteur</button>
        ${sommeParts && sommeParts !== 100 ? `<div class="muted small" style="color:var(--warn);margin-top:6px">⚠️ Les parts totalisent ${sommeParts} % (attendu 100 %).</div>` : ""}
      </div>

      <div class="result">
        <div class="line"><span>Valeur des titres</span><b>${eur(valeur)}</b></div>
        ${a.dutreil ? `<div class="line"><span>Exonération Dutreil (−75 %, art. 787 B)</span><b style="color:var(--accent-2)">− ${eur(valeur * 0.75)}</b></div>
        <div class="line total"><span>Assiette taxable en transmission</span><b>${eur(valeur * 0.25)}</b></div>` : `<div class="line"><span class="muted small">Sans pacte Dutreil : assiette taxable = valeur pleine.</span></div>`}
        ${tUS != null ? `<div class="line"><span>Démembrement — usufruitier ${usPers.nom} (${age} ans${a.demembrementAnnee ? " en " + a.demembrementAnnee : ", âge actuel"}) → usufruit ${pct(tUS)} / NP ${pct(1 - tUS)}</span><b>NP transmise : ${eur(npVal)}</b></div>` : ""}
        ${a.dutreil && npVal != null ? `<div class="line total"><span>💡 Donation de la nue-propriété sous Dutreil → base taxable</span><b>${eur(npVal)} × 25 % = ${eur(npVal * 0.25)}</b></div>` : ""}
      </div>
    </div>`;
  };

  c.innerHTML = `
    <div class="card">
      <h2>🏭 Entreprise — titres, Dutreil & démembrement</h2>
      <p class="muted small">Espace dédié aux sociétés (parts / actions). Gère la <b>forme juridique</b>, le <b>pacte Dutreil</b> (−75 % d'assiette) et le <b>démembrement des titres</b> (usufruit conservé par le dirigeant, nue-propriété donnée aux enfants — valorisée selon le barème 669 CGI d'après l'âge de l'usufruitier).</p>
      ${ents.map(card).join("") || `<p class="muted">Aucune entreprise. Ajoute-en une ci-dessous.</p>`}
      <button class="btn primary" data-add="entreprise">+ Ajouter une entreprise</button>
    </div>
    <p class="muted small center">Ces sociétés apparaissent aussi dans le <b>🏦 Patrimoine</b> (catégorie Entreprise) et le <b>🏠 Résumé</b>.</p>`;

  c.onclick = (e) => {
    const verif = e.target.closest("[data-verif]");
    if (verif) { const a = A[+verif.dataset.verif]; a.verifie = !a.verifie; save(); renderEntreprise(); return; }
    const add = e.target.closest("[data-add]");
    if (add) {
      if (add.dataset.add === "entreprise") {
        A.push({ id: uid(), libelle: "", categorie: "entreprise", forme: "", valeur: 0, annee: null, dutreil: true });
        state.actifs = A;
      } else if (add.dataset.add === "entdet") {
        const ent = A[+add.dataset.ai];
        D.push({ proprietaire: state.personnes[0]?.id || "", actifRef: ent.id, part: 0, droit: "PP" });
        state.detentions = D;
      }
      save(); renderEntreprise(); return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      if (del.dataset.del === "entreprise") {
        const removed = A[+del.dataset.ai];
        A.splice(+del.dataset.ai, 1);
        state.actifs = A;
        state.detentions = D.filter((d) => d.actifRef !== removed.id);
      } else if (del.dataset.del === "entdet") {
        D.splice(+del.dataset.di, 1);
      }
      save(); renderEntreprise(); return;
    }
  };

  c.oninput = (e) => {
    const t = e.target;
    if (t.dataset.ai != null) {
      const a = A[+t.dataset.ai];
      if (t.classList.contains("e_lib")) a.libelle = t.value;
      else if (t.classList.contains("e_val")) { a.valeur = parseNum(t.value); save(); renderEntreprise(); return; }
      else if (t.classList.contains("e_an")) a.annee = t.value === "" ? null : Number(t.value);
      else if (t.classList.contains("e_dutan")) a.dutreilAnnee = t.value === "" ? null : Number(t.value);
      else if (t.classList.contains("e_demyr")) { a.demembrementAnnee = t.value === "" ? null : Number(t.value); save(); renderEntreprise(); return; }
      else return;
      save();
    } else if (t.dataset.di != null && t.classList.contains("ed_part")) {
      D[+t.dataset.di].part = parsePart(t.value); save();
    }
  };

  c.onchange = (e) => {
    const t = e.target;
    if (t.dataset.ai != null) {
      const a = A[+t.dataset.ai];
      if (t.classList.contains("e_forme")) { a.forme = t.value; save(); }
      else if (t.classList.contains("e_dut")) { a.dutreil = t.checked; save(); renderEntreprise(); }
    } else if (t.dataset.di != null) {
      const d = D[+t.dataset.di];
      if (t.classList.contains("ed_prop")) d.proprietaire = t.value;
      else if (t.classList.contains("ed_droit")) d.droit = t.value;
      else return;
      save(); renderEntreprise();
    }
  };
}

// ---------- Onglet Conseil & optimisation (IA) ----------
const conseilMessages = []; // conversation en mémoire (non sauvegardée)
const conseilObjectifs = new Set(["Minimiser les droits de succession"]);
const OBJECTIFS = [
  "Minimiser les droits de succession",
  "Protéger le conjoint survivant",
  "Égalité entre les enfants",
  "Garder des revenus / le contrôle",
  "Préparer une vente / de la liquidité",
  "Anticiper par des donations",
];

function buildConseilContext(d) {
  const e = (n) => Math.round(n || 0).toLocaleString("fr-FR") + " €";
  const avTotal = (d.avAvant70 || 0) + (d.avApres70 || 0);
  const L = [];
  L.push(`Régime matrimonial des parents : ${REGIME_LABEL[d.regime] || "non précisé"}.`);
  L.push(`Patrimoine net des biens : ${e(d.patrimoineFoyer)}. Assurance-vie : ${e(avTotal)} (avant 70 ans ${e(d.avAvant70)}, après 70 ans ${e(d.avApres70)}). Patrimoine global : ${e(d.patrimoineFoyer + avTotal)}.`);
  L.push(`Dettes totales : ${e(d.totalDettes)}.${d.exonerationDutreil > 0 ? ` Exonération Dutreil : ${e(d.exonerationDutreil)}.` : ""}`);
  L.push(`Assiette taxable succession (hors assurance-vie) : ${e(d.patrimoineTaxable)}. Droits de succession estimés aujourd'hui : ${e(d.droitsSuccessionEstimes)}.`);
  const cats = Object.entries(d.parCategorie).map(([k, v]) => `${k} ${e(v)}`).join(", ");
  if (cats) L.push(`Exposition par catégorie : ${cats}.`);
  state.personnes.forEach((p) => {
    const items = d.parPersonneDetail[p.id] || [];
    if (items.length) L.push(`${p.nom} (${p.role}) détient : ` + items.map((it) => `${it.libelle} ${it.part}% ${it.droit}${it.droit !== "PP" ? ` [669 ${Math.round(it.fraction * 100)}%]` : ""} = ${e(it.valeur)}`).join(" ; ") + ".");
  });
  (state.av || []).forEach((a) => {
    const bens = (a.beneficiaires || []).map((b) => { const nom = personne(b)?.nom || b; const pc = a.repartition?.[b]; return pc ? `${nom} ${pc}%` : nom; }).join(" / ");
    L.push(`Assurance-vie "${a.libelle || a.id}" chez ${a.etablissement || "?"}, souscripteur ${personne(a.souscripteurId)?.nom || "?"}${a.cosouscripteurId ? " & " + (personne(a.cosouscripteurId)?.nom || "") : ""}, capital ${e(a.montant)}, primes ${a.avant70 ? "avant" : "après"} 70 ans, bénéficiaires : ${bens || "à définir"}.`);
  });
  (state.donations || []).forEach((x) => {
    const purge = anneesEcoulees(x.date) >= DELAI_RAPPEL_ANS;
    L.push(`Donation ${x.date} : ${personne(x.donateurId)?.nom || "?"} → ${personne(x.beneficiaireId)?.nom || "?"}, ${e(x.montant)} (${purge ? "purgée >15 ans" : "rapportable <15 ans"}).`);
  });
  L.push(`Capacité de donation encore exonérée (abattements 100 000 € /parent /enfant non utilisés) : ${e(d.capaciteExoneree)}.`);
  if (d.scenarios) L.push(`Scénarios de droits totaux pour les enfants : attribution intégrale au conjoint = ${e(d.scenarios.attribution.total)} ; transmission à chaque décès = ${e(d.scenarios.progressif.total)} ; décès simultané = ${e(d.scenarios.simultane.total)}.`);
  // Droits estimés par enfant en cas de décès aujourd'hui
  (d.successionParEnfant || []).forEach((x) => L.push(`Si décès aujourd'hui, ${x.nom} reçoit ${e(x.recu)} et paierait ${e(x.droits)} de droits (net ${e(x.net)}).`));
  // Pistes déjà détectées automatiquement par l'app
  if ((d.reco || []).length) L.push("Pistes déjà détectées : " + d.reco.map((r) => r.text.replace(/<[^>]+>/g, "")).join(" ; ") + ".");
  return L.join("\n");
}

const mdLite = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/^\s*[-*]\s+/gm, "• ")
  .replace(/\n/g, "<br>");

function renderConseil() {
  const c = $("#tab-content");
  const d = debrief(state);
  const eur2 = (n) => Math.round(n || 0).toLocaleString("fr-FR") + " €";
  const avTotal = (d.avAvant70 || 0) + (d.avApres70 || 0);
  const aiConfig = sync.getApiUrl() && sync.getApiUrl() !== "/api/data" && sync.getPassword();

  c.innerHTML = `
    <div class="card">
      <h2>📌 Ta situation en clair</h2>
      <div class="result">
        <div class="line"><span>Patrimoine global (biens + assurance-vie)</span><b>${eur2(d.patrimoineFoyer + avTotal)}</b></div>
        <div class="line"><span>Régime matrimonial</span><b>${REGIME_LABEL[d.regime] || "non précisé"}</b></div>
        <div class="line"><span>Assiette taxable succession (hors AV)</span><b>${eur2(d.patrimoineTaxable)}</b></div>
        <div class="line"><span>Droits de succession estimés aujourd'hui</span><b style="color:var(--warn)">${eur2(d.droitsSuccessionEstimes)}</b></div>
        <div class="line"><span>Encore donnable en franchise (abattements 15 ans)</span><b style="color:var(--accent-2)">${eur2(d.capaciteExoneree)}</b></div>
        ${d.scenarios ? `<div class="line total"><span>Coût enfants — meilleur vs pire scénario</span><b>${eur2(Math.min(d.scenarios.progressif.total, d.scenarios.simultane.total, d.scenarios.attribution.total))} → ${eur2(Math.max(d.scenarios.progressif.total, d.scenarios.simultane.total, d.scenarios.attribution.total))}</b></div>` : ""}
      </div>
    </div>

    <div class="card">
      <h3>🎯 Tes priorités <span class="muted small">(orientent les conseils de l'IA)</span></h3>
      <div class="benef-row">
        ${OBJECTIFS.map((o) => `<label class="benef-chk"><input type="checkbox" class="obj" data-o="${o}" ${conseilObjectifs.has(o) ? "checked" : ""}> ${o}</label>`).join("")}
      </div>
    </div>

    <div class="card">
      <h2>🤖 Discuter avec l'IA</h2>
      ${aiConfig
        ? `<button id="strat_go" class="btn primary" style="margin-bottom:6px">⚡ Générer ma stratégie d'optimisation</button>
           <p class="muted small">Un plan concret et chiffré, calé sur tes priorités et tes données. Indicatif — à valider avec un notaire.</p>
           <div id="strategie" style="margin:8px 0 4px"></div>
           <hr style="border:none;border-top:1px solid var(--line);margin:18px 0 14px">
           <p class="muted small">Ou pose tes questions / hypothèses (« et si je donne 100 000 € à chacun ? »).</p>
           <div class="chips" style="margin-bottom:12px">
             ${["Fais une synthèse et donne-moi les 3 leviers prioritaires", "Si un parent décède demain, qui paie quoi ?", "Comment réduire les droits sur l'entreprise ?", "Quel intérêt à donner la nue-propriété maintenant ?"].map((q) => `<button class="chip suggest" style="cursor:pointer">${q}</button>`).join("")}
           </div>
           <div id="chat" class="chat-box"></div>
           <div class="form-row" style="margin-top:12px;align-items:flex-end">
             <label style="flex:1">Ta question<textarea id="chat_in" rows="2" placeholder="ex : combien chaque enfant paierait au 2nd décès ?"></textarea></label>
             <button id="chat_send" class="btn primary">Envoyer</button>
           </div>`
        : `<p class="muted">L'IA nécessite ton Worker Cloudflare + le secret <b>ANTHROPIC_API_KEY</b> (voir README). Renseigne aussi l'URL et le mot de passe dans l'onglet <b>📥 Données</b>.</p>`}
    </div>`;

  $$("#tab-content .obj").forEach((el) => el.addEventListener("change", (e2) => {
    e2.target.checked ? conseilObjectifs.add(e2.target.dataset.o) : conseilObjectifs.delete(e2.target.dataset.o);
  }));

  if (!aiConfig) return;

  const chat = $("#chat");
  const renderChat = () => {
    chat.innerHTML = conseilMessages.map((m) => `<div class="bubble ${m.role}">${m.role === "assistant" ? mdLite(m.content) : mdLite(m.content)}</div>`).join("") || `<div class="muted small center">Pose une question ou clique une suggestion ci-dessus.</div>`;
    chat.scrollTop = chat.scrollHeight;
  };
  renderChat();

  const buildSystem = () => {
    const objTxt = [...conseilObjectifs].join(", ") || "réduire les droits et transmettre au mieux";
    return `Tu es un conseiller en gestion de patrimoine et transmission (droit français, barèmes 2026). Tu aides une famille à comprendre et optimiser sa situation.
Règles : utilise UNIQUEMENT les données du contexte pour tout chiffre ; si une donnée manque, dis-le. Explique simplement, avec des ordres de grandeur chiffrés. Propose des leviers concrets et priorisés : donation démembrée (nue-propriété, barème 669), abattements 100 000 € /parent /enfant tous les 15 ans, don familial de somme 790 G (31 865 €), assurance-vie (abattement 152 500 €/bénéficiaire avant 70 ans), pacte Dutreil (−75 % sur les titres d'entreprise), choix du régime matrimonial, exonération temporaire logement 790 A bis (jusqu'au 31/12/2026). Sois concis. Priorités de la famille : ${objTxt}. Termine les recommandations importantes par « à valider avec un notaire ». Tu ne donnes pas de conseil juridique définitif.

=== CONTEXTE PATRIMONIAL ===
${buildConseilContext(d)}`;
  };

  const send = async (question) => {
    const q = (question || $("#chat_in").value).trim();
    if (!q) return;
    $("#chat_in").value = "";
    conseilMessages.push({ role: "user", content: q });
    conseilMessages.push({ role: "assistant", content: "…réflexion en cours…" });
    renderChat();
    $("#chat_send").disabled = true;
    try {
      const answer = await askAI(buildSystem(), conseilMessages.filter((m) => m.content !== "…réflexion en cours…"));
      conseilMessages[conseilMessages.length - 1] = { role: "assistant", content: answer || "(réponse vide)" };
    } catch (err) {
      conseilMessages[conseilMessages.length - 1] = { role: "assistant", content: "⚠️ " + err.message };
    }
    $("#chat_send").disabled = false;
    renderChat();
  };

  $("#strat_go").addEventListener("click", async () => {
    const box = $("#strategie");
    const btn = $("#strat_go");
    btn.disabled = true;
    box.innerHTML = `<div class="muted small">⚙️ L'IA construit ta stratégie…</div>`;
    const prompt = `En te basant sur ma situation et mes priorités, rédige ma STRATÉGIE D'OPTIMISATION de transmission, structurée ainsi :
1. **Diagnostic** (3 lignes max : où en est le patrimoine, quel est l'enjeu fiscal principal).
2. **Leviers prioritaires** : 3 à 5 actions, de la plus rentable à la moins, avec pour chacune l'**économie estimée en €** (fondée sur mes chiffres).
3. **Plan d'action** : étapes concrètes dans l'ordre (quoi faire cette année, puis dans 15 ans, etc.).
4. **Impact par personne** : ce que ça change pour le conjoint et pour chaque enfant.
5. **Points de vigilance**.
Sois concret et chiffré.`;
    try {
      const answer = await askAI(buildSystem(), [{ role: "user", content: prompt }]);
      box.innerHTML = `<div class="bubble assistant" style="max-width:100%">${mdLite(answer || "(réponse vide)")}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="result"><b style="color:var(--danger)">⚠️ ${err.message}</b></div>`;
    }
    btn.disabled = false;
  });

  $("#chat_send").addEventListener("click", () => send());
  $("#chat_in").addEventListener("keydown", (e2) => { if (e2.key === "Enter" && (e2.metaKey || e2.ctrlKey)) send(); });
  $$("#tab-content .suggest").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
}

// ---------- Onglet Par banque / établissement ----------
function renderBanques() {
  const c = $("#tab-content");
  const banques = {};
  const add = (name, type, item, montant) => {
    const key = (name || "").trim() || "(non précisé)";
    (banques[key] ||= { av: [], actifs: [], total: 0 });
    banques[key][type].push(item);
    banques[key].total += montant;
  };
  (state.av || []).forEach((a) => add(a.etablissement, "av", a, Number(a.montant) || 0));
  (state.actifs || []).forEach((a) => { if ((a.etablissement || "").trim()) add(a.etablissement, "actifs", a, Number(a.valeur) || 0); });

  const entries = Object.entries(banques).sort((x, y) => y[1].total - x[1].total);
  const totalGlobal = entries.reduce((s, [, v]) => s + v.total, 0) || 1;

  c.innerHTML = `
    <div class="card">
      <h2>🏛️ Répartition par établissement</h2>
      <p class="muted small">Vue consolidée par banque / assureur / courtier. Renseigne le champ « Banque » sur tes comptes titres & liquidités (onglet Patrimoine) et sur tes contrats (onglet Assurance-vie) pour tout retrouver ici.</p>
      ${
        entries.length
          ? `<div class="kpi"><span>Total logé dans des établissements identifiés</span><b>${eur(totalGlobal)}</b></div>`
          : `<p class="muted">Aucun établissement renseigné pour l'instant.</p>`
      }
    </div>
    ${entries.map(([nom, v]) => {
      const part = (v.total / totalGlobal) * 100;
      const rows = [
        ...v.av.map((a) => `<tr><td>🛡️ Assurance-vie</td><td>${a.libelle || a.id}</td><td class="muted small">${a.avant70 ? "avant 70 ans" : "après 70 ans"}</td><td style="text-align:right">${eur(a.montant)}</td></tr>`),
        ...v.actifs.map((a) => `<tr><td>${CAT_LOOKUP[a.categorie] || a.categorie}</td><td>${a.libelle || a.id}</td><td class="muted small"></td><td style="text-align:right">${eur(a.valeur)}</td></tr>`),
      ].join("");
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0">🏛️ ${nom}</h3>
          <b style="font-size:18px;color:var(--accent)">${eur(v.total)} <span class="muted small">· ${part.toFixed(0)} %</span></b>
        </div>
        <div class="gauge" style="margin:10px 0"><div class="gauge-fill" style="width:${part}%"></div></div>
        <table class="grid"><thead><tr><th>Type</th><th>Contrat / compte</th><th></th><th style="text-align:right">Montant</th></tr></thead>
          <tbody>${rows}</tbody></table>
      </div>`;
    }).join("")}`;
}

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
